import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), workspaceFor: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor, workspaceFor: mocks.workspaceFor }));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));

import app from "./index";

const user = { id: "local_author", login: "alice", name: "Alice", avatar_url: null };
const workspace = { id: "local_workspace", name: "Design", role: "owner", clerkOrganizationId: "org_design" };
const file = { id: "file_design", workspace_id: workspace.id, name: "Screens", library_id: null, created_at: 1, updated_at: 1 };
const env = { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }), first: async () => ({ share_token: null }) }) }) } } as unknown as Env;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user, workspaces: [workspace], organizationId: "org_design", method: "session", scopes: [], clerkUserId: "user_clerk_alice", sessionExpiresAt: Date.now() + 60_000 });
  mocks.fileFor.mockResolvedValue(file);
  mocks.workspaceFor.mockResolvedValue(workspace);
});

describe("authenticated file bootstrap", () => {
  it("returns the verified local author with authorized file metadata in one response", async () => {
    const response = await app.request("https://sharpner.example/api/files/file_design", {
      headers: { authorization: "Bearer session_fixture", "x-actor": JSON.stringify({ id: "forged_author" }) },
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ user, file, workspace, files: [], shareToken: null });
    expect(mocks.authenticate).toHaveBeenCalledTimes(1);
    expect(mocks.fileFor).toHaveBeenCalledWith(env, user.id, file.id);
    expect(mocks.workspaceFor).toHaveBeenCalledWith(env, user.id, workspace.id);
  });

  it("requires a current session before returning bootstrap data", async () => {
    mocks.authenticate.mockResolvedValue(null);
    const response = await app.request("https://sharpner.example/api/files/file_design", {}, env);
    expect(response.status).toBe(401);
    expect(mocks.fileFor).not.toHaveBeenCalled();
  });

  it("does not return the author or file bootstrap to another workspace's member", async () => {
    mocks.fileFor.mockResolvedValue(null);
    const response = await app.request("https://sharpner.example/api/files/file_design", {}, env);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not found" });
    expect(mocks.workspaceFor).not.toHaveBeenCalled();
  });
});
