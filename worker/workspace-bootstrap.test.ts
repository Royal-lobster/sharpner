import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./thumbnail-queue", () => ({ ThumbnailQueue: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));

import app from "./index";

const user = { id: "local_author", login: "alice", name: "Alice", avatar_url: null };
const workspace = { id: "local_workspace", name: "Design", role: "owner", clerkOrganizationId: "org_design" };
const identity = { user, workspaces: [workspace], organizationId: "org_design", method: "session", scopes: [], clerkUserId: "user_clerk_alice", sessionExpiresAt: Date.now() + 60_000 };
const expectedFiles = [
  { id: "screens", name: "Screens", cover: "/a/screens/cover.webp", library_id: "library", created_at: 1, updated_at: 3, used_by: 0 },
  { id: "library", name: "Library", cover: null, library_id: null, created_at: 1, updated_at: 2, used_by: 1 },
];

class Statement {
  constructor(private db: DatabaseSync, private sql: string, private values: SQLInputValue[] = []) {}
  bind(...values: SQLInputValue[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values) as T[] }; }
}

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue(identity);
});

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  db.exec("PRAGMA foreign_keys = ON");
  for (const name of ["0001_init.sql", "0002_clerk_accounts.sql"]) db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  db.exec(`
    INSERT INTO users (id, login, name, created_at, clerk_user_id) VALUES ('local_author', 'alice', 'Alice', 1, 'user_clerk_alice');
    INSERT INTO workspaces (id, name, created_at, clerk_organization_id) VALUES
      ('local_workspace', 'Design', 1, 'org_design'), ('private_workspace', 'Private', 1, 'org_private');
    INSERT INTO members VALUES ('local_workspace', 'local_author', 'owner', 1);
    INSERT INTO files (id, workspace_id, name, cover, library_id, created_by, created_at, updated_at) VALUES
      ('library', 'local_workspace', 'Library', NULL, NULL, 'local_author', 1, 2),
      ('screens', 'local_workspace', 'Screens', '/a/screens/cover.webp', 'library', 'local_author', 1, 3),
      ('private', 'private_workspace', 'Private file', NULL, NULL, 'local_author', 1, 4);
  `);
  const prepare = vi.fn((sql: string) => new Statement(db, sql));
  const env = { DB: { prepare } } as unknown as Env;
  const request = (path = "/me") => app.request(`https://sharpner.example/api${path}`, {
    headers: { authorization: "Bearer session_fixture" },
  }, env);
  return { db, env, prepare, request };
}

describe("authenticated workspace bootstrap", () => {
  it("returns the active workspace's files with verified identity in one authenticated response", async () => {
    const f = fixture();
    const response = await f.request("/me?workspace=private_workspace");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user, workspaces: [workspace], activeWorkspaceId: workspace.id, files: expectedFiles });
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.authenticate).toHaveBeenCalledWith(f.env, expect.any(Request), "session");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each([null, "org_private", "org_removed"])("does not query files when active organization %s is unavailable to this identity", async (organizationId) => {
    const f = fixture();
    mocks.authenticate.mockResolvedValue({ ...identity, organizationId });
    const response = await f.request();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user, workspaces: [workspace], activeWorkspaceId: null, files: [] });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated requests before reading workspace files", async () => {
    const f = fixture();
    mocks.authenticate.mockResolvedValue(null);
    const response = await f.request();
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("reauthenticates later bootstrap requests and does not reuse a removed membership", async () => {
    const f = fixture();
    expect((await f.request()).status).toBe(200);
    mocks.authenticate.mockResolvedValue({ ...identity, workspaces: [] });
    f.prepare.mockClear();
    const response = await f.request();
    expect(await response.json()).toEqual({ user, workspaces: [], activeWorkspaceId: null, files: [] });
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it("keeps detail refreshes identical while reading current files and authenticating every request", async () => {
    const f = fixture();
    const response = await f.request(`/workspaces/${workspace.id}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ workspace, files: expectedFiles });
    f.db.prepare("UPDATE files SET name = 'Updated screens' WHERE id = 'screens'").run();
    const refreshed = await f.request(`/workspaces/${workspace.id}`);
    expect(await refreshed.json()).toEqual({ workspace, files: [{ ...expectedFiles[0], name: "Updated screens" }, expectedFiles[1]] });
    expect(mocks.authenticate).toHaveBeenCalledTimes(2);
    expect(refreshed.headers.get("cache-control")).toBe("no-store");
  });

  it("denies detail refreshes for another workspace", async () => {
    const f = fixture();
    const response = await f.request("/workspaces/private_workspace");
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
});
