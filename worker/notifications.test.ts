import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverMentions, listNotifications, markNotificationsRead, mentionEmail, resolveMentions, workspaceMembers, type MentionEvent } from "./notifications";
import type { Actor } from "../shared/types";

/** D1's small async surface over real SQLite. */
class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
  async run() { this.db.prepare(this.sql).run(...this.values); return { success: true }; }
}

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

/** Alice, Bob and Dana share Acme; Carol works alone in Solo; Eve was never linked to Clerk. */
function fixture(vars: Partial<Env> = {}) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_init.sql", "0002_clerk_accounts.sql", "0003_file_share_links.sql", "0004_agent_friction.sql", "0005_mention_notifications.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  db.exec(`
    INSERT INTO users (id, login, name, email, created_at, clerk_user_id) VALUES
      ('alice', 'alice', 'Alice', 'alice@example.com', 0, 'c_alice'), ('bob', 'bob', 'Bob', 'bob@example.com', 0, 'c_bob'),
      ('dana', 'dana', 'Dana', NULL, 0, 'c_dana'), ('carol', 'carol', 'Carol', 'carol@example.com', 0, 'c_carol');
    INSERT INTO users (id, login, name, created_at) VALUES ('eve', 'eve', 'Eve', 0);
    INSERT INTO workspaces (id, name, created_at) VALUES ('acme', 'Acme', 0), ('solo', 'Solo', 0);
    INSERT INTO members VALUES ('acme', 'alice', 'owner', 0), ('acme', 'bob', 'member', 0), ('acme', 'dana', 'member', 0),
      ('acme', 'eve', 'member', 0), ('solo', 'carol', 'owner', 0);
    INSERT INTO files (id, workspace_id, name, created_by, created_at, updated_at) VALUES ('app', 'acme', 'App', 'alice', 0, 0);
  `);
  const env = { ...vars, DB: {
    prepare: (sql: string) => new Statement(db, sql),
    batch: (statements: Statement[]) => Promise.all(statements.map((s) => s.all())),
  } } as unknown as Env;
  return { db, env };
}

const alice: Actor = { id: "alice", name: "Alice", avatar: null };
const event = (author: Actor = alice, body = "@Bob can you check the <b>spacing</b>?"): Omit<MentionEvent, "location"> => ({
  workspaceId: "acme", file: { id: "app", name: "App" }, origin: "https://sharpner.example",
  thread: { id: "thread", number: 7, pageId: "page" }, message: { id: "m1", author, body, createdAt: 50 },
});
const locate = async () => "Checkout · Cart";

describe("mention recipients", () => {
  it("lists linked workspace members for suggestions", async () => {
    const { env } = fixture();
    expect((await workspaceMembers(env, "acme")).map((m) => m.id)).toEqual(["alice", "bob", "dana"]);
  });

  it("keeps only current, linked members of the file's workspace", async () => {
    const { env } = fixture();
    const found = await resolveMentions(env, "acme", ["bob", "carol", "eve", "ghost", "bob"]);
    expect(found).toEqual([{ id: "bob", name: "Bob", avatar: null, email: "bob@example.com" }]);
    expect(await resolveMentions(env, "acme", undefined)).toEqual([]);
  });
});

describe("mention notifications", () => {
  it("tells each tagged member who tagged them, where, and what the comment says", async () => {
    const { env } = fixture();
    await deliverMentions(env, event(), await resolveMentions(env, "acme", ["bob", "alice"]), locate);
    const bob = await listNotifications(env, "bob");
    expect(bob.unread).toBe(1);
    expect(bob.notifications).toEqual([expect.objectContaining({
      fileId: "app", fileName: "App", threadId: "thread", threadNumber: 7, pageId: "page", location: "Checkout · Cart",
      excerpt: "@Bob can you check the <b>spacing</b>?", actor: alice, createdAt: 50, readAt: null,
    })]);
    // Tagging yourself is not news.
    expect((await listNotifications(env, "alice")).notifications).toEqual([]);
  });

  it("notifies a member their own agent tagged", async () => {
    const { env } = fixture();
    const agent = { ...alice, name: "Alice's agent", agent: true };
    await deliverMentions(env, event(agent, "@Alice the fix is ready"), await resolveMentions(env, "acme", ["alice"]), locate);
    expect((await listNotifications(env, "alice")).notifications).toEqual([expect.objectContaining({ actor: agent })]);
  });

  it("hides notifications from a workspace the member left, and from deleted files", async () => {
    const { db, env } = fixture();
    await deliverMentions(env, event(), await resolveMentions(env, "acme", ["bob", "dana"]), locate);
    db.exec(`DELETE FROM members WHERE user_id = 'bob'`);
    expect(await listNotifications(env, "bob")).toEqual({ notifications: [], unread: 0 });
    db.exec(`DELETE FROM files WHERE id = 'app'`);
    expect(await listNotifications(env, "dana")).toEqual({ notifications: [], unread: 0 });
  });

  it("marks only the member's own notifications read, by id, by thread or all at once", async () => {
    const { env } = fixture();
    const both = await resolveMentions(env, "acme", ["bob", "dana"]);
    await deliverMentions(env, event(), both, locate);
    const later = event();
    await deliverMentions(env, { ...later, thread: { id: "other", number: 8, pageId: "page" }, message: { ...later.message, createdAt: 60 } }, both, locate);
    const [other, thread] = (await listNotifications(env, "bob")).notifications;
    expect([other!.threadId, thread!.threadId]).toEqual(["other", "thread"]);
    await markNotificationsRead(env, "dana", { ids: [other!.id] });
    expect((await listNotifications(env, "bob")).unread).toBe(2);
    await markNotificationsRead(env, "bob", { threadId: "thread" });
    expect((await listNotifications(env, "bob")).notifications.map((n) => [n.threadId, n.readAt !== null])).toEqual([["other", false], ["thread", true]]);
    await markNotificationsRead(env, "bob", { ids: [other!.id] });
    expect((await listNotifications(env, "bob")).unread).toBe(0);
    expect((await listNotifications(env, "dana")).unread).toBe(2);
    await markNotificationsRead(env, "dana", {});
    expect((await listNotifications(env, "dana")).unread).toBe(0);
  });
});

describe("mention email", () => {
  it("is skipped unless Resend is configured", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { env } = fixture({ RESEND_API_KEY: "key" });
    await deliverMentions(env, event(), await resolveMentions(env, "acme", ["bob"]), locate);
    expect(fetch).not.toHaveBeenCalled();
    expect((await listNotifications(env, "bob")).unread).toBe(1);
  });

  it("emails tagged members who have an address, and keeps the inbox entry when sending fails", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 500 }));
    vi.stubGlobal("fetch", fetch);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { env } = fixture({ RESEND_API_KEY: "key", EMAIL_FROM: "Sharpner <notify@example.com>" });
    await deliverMentions(env, event(), await resolveMentions(env, "acme", ["bob", "dana"]), locate);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer key");
    expect(JSON.parse(init.body as string)).toMatchObject({ from: "Sharpner <notify@example.com>", to: ["bob@example.com"], subject: "Alice mentioned you in App" });
    expect((await listNotifications(env, "dana")).unread).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("says why the member was tagged, links to the thread and escapes the comment", () => {
    const email = mentionEmail({ ...event(), location: "Checkout · Cart" });
    expect(email.text).toContain("Alice mentioned you in comment #7 on Checkout · Cart in App:\n\n@Bob can you check the <b>spacing</b>?");
    expect(email.text).toContain("https://sharpner.example/f/app?page=page&comment=thread");
    expect(email.html).toContain("&#60;b&#62;spacing&#60;/b&#62;");
    expect(email.html).not.toContain("<b>");
  });
});
