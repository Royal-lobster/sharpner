import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), workspaceFor: vi.fn(), destroy: vi.fn(), setLibrary: vi.fn(), run: vi.fn(), all: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({
  ...await original<typeof import("./data")>(),
  fileFor: mocks.fileFor, workspaceFor: mocks.workspaceFor,
  room: () => ({ destroy: mocks.destroy, setLibrary: mocks.setLibrary }),
}));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./thumbnail-queue", () => ({ ThumbnailQueue: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));
import app from "./index";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const file = { id: "file_design", workspace_id: "ws", name: "Screens", library_id: null, created_at: 1, updated_at: 1 };
const workspace = (role: "owner" | "member") => ({ id: "ws", name: "Design", role, clerkOrganizationId: "org_design" });
const env = { DB: { prepare: () => ({ bind: () => ({ run: mocks.run, all: mocks.all }) }) } } as unknown as Env;
const remove = () => app.request(`https://sharpner.example/api/files/${file.id}`, { method: "DELETE", headers: { origin: "https://sharpner.example" } }, env);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user, workspaces: [], organizationId: null, method: "session", scopes: [], clerkUserId: "user_clerk", sessionExpiresAt: Date.now() + 60_000 });
  mocks.fileFor.mockResolvedValue(file);
  mocks.all.mockResolvedValue({ results: [{ id: "dependent" }] });
});

describe("file deletion", () => {
  it("lets a workspace owner delete a file and unlinks files that used it as a library", async () => {
    mocks.workspaceFor.mockResolvedValue(workspace("owner"));
    expect((await remove()).status).toBe(204);
    expect(mocks.workspaceFor).toHaveBeenCalledWith(env, user.id, file.workspace_id);
    expect(mocks.destroy).toHaveBeenCalledWith(file.id);
    expect(mocks.run).toHaveBeenCalled();
    expect(mocks.setLibrary).toHaveBeenCalledWith("dependent", null);
  });

  it("refuses a regular member without touching the file", async () => {
    mocks.workspaceFor.mockResolvedValue(workspace("member"));
    const response = await remove();
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "Only workspace owners can delete files" });
    expect(mocks.destroy).not.toHaveBeenCalled();
    expect(mocks.run).not.toHaveBeenCalled();
    expect(mocks.setLibrary).not.toHaveBeenCalled();
  });

  it("hides the file from someone outside its workspace", async () => {
    mocks.fileFor.mockResolvedValue(null);
    expect((await remove()).status).toBe(404);
    expect(mocks.workspaceFor).not.toHaveBeenCalled();
    expect(mocks.destroy).not.toHaveBeenCalled();
  });
});
