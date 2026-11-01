import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(), fileFor: vi.fn(), filesFor: vi.fn(), workspacesFor: vi.fn(),
  apply: vi.fn(), cover: vi.fn(), outline: vi.fn(),
}));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({
  ...await original<typeof import("./data")>(), fileFor: mocks.fileFor, filesFor: mocks.filesFor, workspacesFor: mocks.workspacesFor,
  room: () => ({ apply: mocks.apply, cover: mocks.cover, outline: mocks.outline, peers: async () => [], comments: async () => [] }),
}));
import { mcp } from "./mcp";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const actor = { id: "alice", name: "Alice's agent", avatar: null, agent: true };
const file = { id: "file", workspace_id: "workspace", name: "Example app", library_id: null };
let scopes: string[];

async function call(name: string, args: unknown) {
  const list = name === "tools/list";
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: list ? name : "tools/call", params: list ? {} : { name, arguments: args } }),
  }, { DB: { prepare: () => ({ bind: () => ({ first: async () => ({ last_file_id: "file" }) }) }) } } as unknown as Env);
  const { result } = await response.json() as { result: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  return { ...result, value: result.content?.[0] && !result.isError ? JSON.parse(result.content[0].text) : undefined };
}

beforeEach(() => {
  vi.resetAllMocks();
  scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user, method: "oauth", scopes }));
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "file" ? file : null);
  mocks.filesFor.mockResolvedValue([file]);
  mocks.workspacesFor.mockResolvedValue([{ id: "workspace", name: "Example", role: "member", clerkOrganizationId: "org" }]);
  mocks.outline.mockResolvedValue([{ id: "cover-page", name: "Cover", sort: 0, description: "The workspace cover.", nodes: [] }]);
  mocks.cover.mockResolvedValue({ nodeId: "cover", url: "/a/file/t/cover-1-hi.webp" });
});

describe("agent file covers", () => {
  it("advertises cover selection and pins it with the member's agent attribution", async () => {
    expect((await call("tools/list", {})).tools!.map((t) => t.name)).toContain("set_cover");
    const result = await call("set_cover", { fileId: "file", nodeId: "cover" });
    expect(mocks.apply).toHaveBeenCalledWith("file", "https://sharpner.example", [{ t: "cover.set", id: "cover" }], actor);
    expect(result.value).toEqual({ ok: true, cover: { nodeId: "cover", url: "https://sharpner.example/a/file/t/cover-1-hi.webp" } });
  });

  it("resets automatic selection explicitly and can report a pending preview", async () => {
    mocks.cover.mockResolvedValue({ nodeId: null, url: "/a/file/t/home-1-hi.webp" });
    expect((await call("set_cover", { fileId: "file", nodeId: null })).value.cover)
      .toEqual({ nodeId: null, url: "https://sharpner.example/a/file/t/home-1-hi.webp" });
    expect(mocks.apply).toHaveBeenLastCalledWith("file", "https://sharpner.example", [{ t: "cover.set", id: null }], actor);
    mocks.cover.mockResolvedValue({ nodeId: "cover", url: null });
    expect((await call("set_cover", { fileId: "file", nodeId: "cover" })).value.cover).toEqual({ nodeId: "cover", url: null });
  });

  it("exposes the file's cover when reading one page and in the active file state", async () => {
    const expected = { nodeId: "cover", url: "https://sharpner.example/a/file/t/cover-1-hi.webp" };
    const detail = await call("get_file", { fileId: "file", pageId: "cover-page" });
    expect(detail.value).toMatchObject({ id: "file", cover: expected, pages: [{ id: "cover-page" }] });
    const state = await call("get_app_state", {});
    expect(state.value.active).toMatchObject({ fileId: "file", cover: expected });
    expect(state.value.workspaces[0].files).toEqual([{ id: "file", name: "Example app", libraryFileId: null }]);
  });

  it("lets read-only agents inspect covers while blocking pinning and resetting", async () => {
    scopes = ["sharpner:read"];
    expect((await call("get_file", { fileId: "file" })).value.cover.nodeId).toBe("cover");
    expect((await call("set_cover", { fileId: "file", nodeId: "cover" })).isError).toBe(true);
    expect((await call("set_cover", { fileId: "file", nodeId: null })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("checks workspace membership before reading or changing a cover", async () => {
    expect((await call("get_file", { fileId: "other-file" })).isError).toBe(true);
    expect((await call("set_cover", { fileId: "other-file", nodeId: "cover" })).isError).toBe(true);
    expect(mocks.cover).not.toHaveBeenCalled();
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it("rejects omitted or empty choices and surfaces invalid-node errors", async () => {
    expect((await call("set_cover", { fileId: "file" })).isError).toBe(true);
    expect((await call("set_cover", { fileId: "file", nodeId: "" })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
    mocks.apply.mockRejectedValue(new Error("Cover must be a frame or image in this file"));
    expect((await call("set_cover", { fileId: "file", nodeId: "component" })).isError).toBe(true);
    expect(mocks.cover).not.toHaveBeenCalled();
  });
});
