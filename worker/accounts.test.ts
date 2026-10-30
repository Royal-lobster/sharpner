import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { ClerkClient, WebhookEvent } from "@clerk/backend";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountError, handleAccountWebhook, syncAccount } from "./accounts";

/** D1's small async surface over real SQLite, including atomic batches. */
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async run() { this.execute(); return { success: true }; }
  execute() {
    const statement = this.db.prepare(this.sql);
    if (statement.columns().length) return { success: true, results: statement.all(...this.values) };
    statement.run(...this.values);
    return { success: true, results: [] };
  }
}

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_init.sql", "0002_clerk_accounts.sql"]) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  const revoked: { fileId: string; userId: string | undefined }[] = [];
  const revokeAccess = vi.fn(async (fileId: string, userId?: string, _reconnect = false) => { revoked.push({ fileId, userId }); });
  const env = {
    DB: {
      prepare: (sql: string) => new Statement(db, sql),
      batch: async (statements: Statement[]) => {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.execute());
          db.exec("COMMIT");
          return results;
        } catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
    FILE_ROOM: {
      idFromName: (id: string) => id,
      get: (fileId: string) => ({ revokeAccess: (userId?: string, reconnect = false) => revokeAccess(fileId, userId, reconnect) }),
    },
  } as unknown as Env;
  const state = {
    user: { id: "user_alice", username: "alice", firstName: "Alice", lastName: "Designer", imageUrl: "https://example.com/alice.jpg", primaryEmailAddressId: "email_alice", emailAddresses: [{ id: "email_alice", emailAddress: "alice@example.com" }] },
    memberships: [membership("org_design", "org:admin")],
  };
  const getUser = vi.fn(async () => state.user);
  const getMemberships = vi.fn(async ({ offset = 0, limit = 100 }: { offset?: number; limit?: number }) => ({ data: state.memberships.slice(offset, offset + limit), totalCount: state.memberships.length }));
  const getOrganization = vi.fn(async ({ organizationId }: { organizationId: string }) => {
    const org = state.memberships.find((m) => m.organization.id === organizationId)?.organization;
    if (!org) throw { status: 404 };
    return org;
  });
  const client = { users: { getUser, getOrganizationMembershipList: getMemberships }, organizations: { getOrganization } } as unknown as ClerkClient;
  const addFile = (id: string, workspaceId = "org_design", userId = "user_alice") => db.prepare(
    `INSERT INTO files (id, workspace_id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 1, 1)`,
  ).run(id, workspaceId, `File ${id}`, userId);
  const rows = (table: string) => db.prepare(`SELECT * FROM ${table}`).all();
  return { db, env, client, state, getUser, getMemberships, getOrganization, revoked, revokeAccess, addFile, rows };
}

function membership(id: string, role: string = "org:member") {
  return { id: `membership_${id}`, role, organization: { id, name: id === "org_design" ? "Design Team" : `Team ${id}`, createdAt: 1 } };
}
const event = (type: string, data: object) => ({ type, data }) as unknown as WebhookEvent;

describe("Clerk account projections", () => {
  it("starts independent Clerk user and membership reads together without projecting partial results", async () => {
    const f = fixture();
    let releaseUser!: () => void;
    f.getUser.mockImplementation(() => new Promise((resolve) => { releaseUser = () => resolve(f.state.user); }));
    const pending = syncAccount(f.env, f.client, "user_alice");
    const membershipsStarted = f.getMemberships.mock.calls.length;
    expect(f.rows("users")).toEqual([]);
    expect(f.rows("members")).toEqual([]);
    releaseUser();
    const account = await pending;
    expect(membershipsStarted).toBe(1);
    expect(account.user.id).toBe("user_alice");
    expect(f.getMemberships).toHaveBeenCalledTimes(1);
  });

  it("does not claim same-name legacy users/workspaces or authorize their legacy memberships", async () => {
    const f = fixture();
    f.db.exec(`INSERT INTO users (id, login, name, created_at) VALUES ('dev_alice', 'alice', 'Alice Designer', 1);
      INSERT INTO workspaces (id, name, created_at) VALUES ('legacy', 'Design Team', 1);
      INSERT INTO members VALUES ('legacy', 'dev_alice', 'owner', 1);`);
    f.addFile("historical", "legacy", "dev_alice");
    const account = await syncAccount(f.env, f.client, "user_alice");
    expect(account.user.id).toBe("user_alice");
    expect(account.workspaces.map((w) => w.id)).toEqual(["org_design"]);
    expect(f.rows("users")).toHaveLength(2);
    expect(f.rows("workspaces")).toHaveLength(2);
    // A leftover local membership attached to a verified user still cannot survive reconciliation.
    f.db.prepare(`INSERT INTO members VALUES ('legacy', 'user_alice', 'owner', 1)`).run();
    await syncAccount(f.env, f.client, "user_alice");
    expect(f.db.prepare(`SELECT * FROM members WHERE workspace_id = 'legacy' AND user_id = 'user_alice'`).get()).toBeUndefined();
    expect(f.revoked).toEqual([{ fileId: "historical", userId: "user_alice" }]);
    expect(f.rows("files")[0]).toMatchObject({ id: "historical", workspace_id: "legacy", created_by: "dev_alice" });
  });

  it("fetches every Clerk membership page and maps only supported roles", async () => {
    const f = fixture();
    f.state.memberships = Array.from({ length: 101 }, (_, i) => membership(`org_${String(i).padStart(3, "0")}`, i === 0 ? "org:admin" : "org:member"));
    const account = await syncAccount(f.env, f.client, "user_alice");
    expect(account.workspaces).toHaveLength(101);
    expect(account.workspaces[0]).toMatchObject({ role: "owner", clerkOrganizationId: "org_000" });
    expect(account.workspaces[100]).toMatchObject({ role: "member", clerkOrganizationId: "org_100" });
    expect(f.getMemberships.mock.calls.map(([args]) => args)).toEqual([
      { userId: "user_alice", limit: 100, offset: 0 }, { userId: "user_alice", limit: 100, offset: 100 },
    ]);
  });

  it("keeps previously linked local IDs and file authors stable through profile and organization changes", async () => {
    const f = fixture();
    f.db.exec(`INSERT INTO users (id, login, name, created_at, clerk_user_id) VALUES ('local-author', 'old-login', 'Old Name', 1, 'user_alice');
      INSERT INTO workspaces (id, name, created_at, clerk_organization_id) VALUES ('local-workspace', 'Old Workspace', 1, 'org_design');
      INSERT INTO members VALUES ('local-workspace', 'local-author', 'owner', 1);`);
    f.addFile("stable", "local-workspace", "local-author");
    f.state.user.username = "new-login";
    f.state.memberships[0]!.organization.name = "New Workspace";
    f.state.memberships[0]!.role = "org:member";
    const account = await syncAccount(f.env, f.client, "user_alice");
    expect(account.user).toMatchObject({ id: "local-author", login: "new-login" });
    expect(account.workspaces).toEqual([{ id: "local-workspace", name: "New Workspace", role: "member", clerkOrganizationId: "org_design" }]);
    expect(f.rows("files")[0]).toMatchObject({ workspace_id: "local-workspace", created_by: "local-author" });
  });

  it("removes lost memberships and closes only that member's affected file sockets", async () => {
    const f = fixture();
    f.state.memberships.push(membership("org_other"));
    await syncAccount(f.env, f.client, "user_alice");
    f.addFile("retained"); f.addFile("revoked", "org_other");
    f.state.memberships = [f.state.memberships[0]!];
    const account = await syncAccount(f.env, f.client, "user_alice");
    expect(account.workspaces.map((w) => w.id)).toEqual(["org_design"]);
    expect(f.rows("members")).toHaveLength(1);
    expect(f.revoked).toEqual([{ fileId: "revoked", userId: "user_alice" }]);
  });

  it("does not prune or partially project when a later Clerk page fails", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("kept");
    f.state.user.firstName = "Not projected";
    f.state.memberships = Array.from({ length: 101 }, (_, i) => membership(`org_new_${i}`));
    f.getMemberships.mockImplementation(async ({ offset = 0 }) => {
      if (offset) throw new Error("upstream unavailable");
      return { data: f.state.memberships.slice(0, 100), totalCount: 101 };
    });
    await expect(syncAccount(f.env, f.client, "user_alice")).rejects.toMatchObject({ status: 503 });
    expect(f.rows("users")[0]).toMatchObject({ name: "Alice Designer" });
    expect(f.rows("members")).toHaveLength(1);
    expect(f.rows("workspaces")).toHaveLength(1);
    expect(f.revoked).toEqual([]);
  });

  it("revokes a prior owner's access when Clerk changes that membership to an unsupported role", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("no-custom-role");
    f.state.memberships[0]!.role = "org:billing_manager";
    await expect(syncAccount(f.env, f.client, "user_alice")).rejects.toMatchObject({ status: 403 });
    expect(f.rows("members")).toEqual([]);
    expect(f.revoked).toEqual([{ fileId: "no-custom-role", userId: "user_alice" }]);
  });

  it("unlinks a deleted Clerk user and closes their sockets while retaining file history", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("history");
    f.getUser.mockRejectedValue({ status: 404 });
    await handleAccountWebhook(f.env, f.client, event("user.deleted", { id: "user_alice" }));
    expect(f.rows("users")[0]).toMatchObject({ id: "user_alice", clerk_user_id: null });
    expect(f.rows("members")).toEqual([]);
    expect(f.rows("files")[0]).toMatchObject({ id: "history", created_by: "user_alice" });
    expect(f.revoked).toEqual([{ fileId: "history", userId: "user_alice" }]);
    await expect(syncAccount(f.env, f.client, "user_alice")).rejects.toBeInstanceOf(AccountError);
  });

  it("unlinks a deleted Clerk organization and closes all its sockets without deleting files", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("history");
    f.getOrganization.mockRejectedValue({ status: 404 });
    await handleAccountWebhook(f.env, f.client, event("organization.deleted", { id: "org_design" }));
    expect(f.rows("workspaces")[0]).toMatchObject({ id: "org_design", clerk_organization_id: null });
    expect(f.rows("members")).toEqual([]);
    expect(f.rows("files")[0]).toMatchObject({ id: "history", workspace_id: "org_design" });
    expect(f.revoked).toEqual([{ fileId: "history", userId: undefined }]);
  });

  it("does not resurrect removed membership from a delayed membership-created webhook", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("private");
    f.state.memberships = [];
    await syncAccount(f.env, f.client, "user_alice");
    await handleAccountWebhook(f.env, f.client, event("organizationMembership.created", {
      public_user_data: { user_id: "user_alice" }, organization: { id: "org_design" }, role: "org:admin",
    }));
    expect(f.rows("members")).toEqual([]);
    expect(f.rows("files")).toHaveLength(1);
  });

  it.each(["membership removal", "user deletion", "organization deletion"])("retains revocation retry information after a socket failure during %s", async (change) => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice");
    f.addFile("must-close");
    let reconcile: () => Promise<unknown>;
    if (change === "membership removal") {
      f.state.memberships = [];
      reconcile = () => syncAccount(f.env, f.client, "user_alice");
    } else if (change === "user deletion") {
      f.getUser.mockRejectedValue({ status: 404 });
      reconcile = () => handleAccountWebhook(f.env, f.client, event("user.deleted", { id: "user_alice" }));
    } else {
      f.getOrganization.mockRejectedValue({ status: 404 });
      reconcile = () => handleAccountWebhook(f.env, f.client, event("organization.deleted", { id: "org_design" }));
    }
    f.revokeAccess.mockRejectedValueOnce(new Error("Durable Object temporarily unavailable"));
    const failure = await reconcile().then(() => null, (error: unknown) => error);
    expect(failure).toBeTruthy();
    // Keep the links and memberships until sockets are closed, so retries still find affected files.
    expect(f.rows("users")[0]).toMatchObject({ clerk_user_id: "user_alice" });
    expect(f.rows("workspaces")[0]).toMatchObject({ clerk_organization_id: "org_design" });
    expect(f.rows("members")).toHaveLength(1);
    expect(failure).toMatchObject({ status: 503 });
    await reconcile();
    expect(f.revokeAccess).toHaveBeenCalledTimes(2);
    expect(f.revokeAccess).toHaveBeenLastCalledWith("must-close", change === "organization deletion" ? undefined : "user_alice", false);
    expect(f.revoked).toEqual([{ fileId: "must-close", userId: change === "organization deletion" ? undefined : "user_alice" }]);
    expect(f.rows("members")).toEqual([]);
    expect(f.rows("files")).toHaveLength(1);
    if (change === "user deletion") expect(f.rows("users")[0]).toMatchObject({ clerk_user_id: null });
    if (change === "organization deletion") expect(f.rows("workspaces")[0]).toMatchObject({ clerk_organization_id: null });
  });

  it.each(["session.ended", "session.removed", "session.revoked"])("closes a user's open sockets for %s without deleting their memberships", async (type) => {
    const f = fixture();
    f.state.memberships.push(membership("org_other"));
    await syncAccount(f.env, f.client, "user_alice");
    f.addFile("session-design"); f.addFile("session-other", "org_other");
    await handleAccountWebhook(f.env, f.client, event(type, { user_id: "user_alice" }));
    expect(f.revoked).toEqual([
      { fileId: "session-design", userId: "user_alice" }, { fileId: "session-other", userId: "user_alice" },
    ]);
    expect(f.revokeAccess).toHaveBeenNthCalledWith(1, "session-design", "user_alice", true);
    expect(f.revokeAccess).toHaveBeenNthCalledWith(2, "session-other", "user_alice", true);
    expect(f.rows("members")).toHaveLength(2);
    expect(f.rows("users")[0]).toMatchObject({ clerk_user_id: "user_alice" });
  });

  it("does not revoke arbitrary users for a session event without a user ID", async () => {
    const f = fixture();
    await syncAccount(f.env, f.client, "user_alice"); f.addFile("kept");
    await expect(handleAccountWebhook(f.env, f.client, event("session.revoked", {}))).rejects.toMatchObject({ status: 503 });
    expect(f.revoked).toEqual([]);
    expect(f.rows("members")).toHaveLength(1);
  });
});
