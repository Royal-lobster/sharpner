import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), agentActive: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({
  ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({ cover: async () => ({ nodeId: null, url: null }), outline: async () => [{ id: "page", name: "Page 1", sort: 0, description: "", nodes: [] }], peers: async () => [], comments: async () => [] }),
}));
import { mcp } from "./mcp";

const file = { id: "file", workspace_id: "workspace", name: "Example app", library_id: null };
const queue = { idFromName: (name: string) => name, get: (id: string) => id === "global" ? { agentActive: mocks.agentActive } : undefined };

async function call(name: string, args: unknown) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, { THUMBNAIL_QUEUE: queue } as unknown as Env);
  return (await response.json() as { result: { isError?: boolean } }).result;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user: { id: "alice", login: "alice", name: "Alice", avatar_url: null }, method: "oauth", scopes: ["sharpner:read"] });
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "file" ? file : null);
  mocks.agentActive.mockResolvedValue(undefined);
});

describe("agent activity", () => {
  it("tells the preview queue an agent is at work when it reads a file, before it writes", async () => {
    expect((await call("get_file", { fileId: "file" })).isError).toBeFalsy();
    expect(mocks.agentActive).toHaveBeenCalledTimes(1);
  });

  it("still answers when the preview queue cannot be reached", async () => {
    mocks.agentActive.mockRejectedValue(new Error("queue unavailable"));
    expect((await call("get_file", { fileId: "file" })).isError).toBeFalsy();
  });

  it("still refuses a file outside the agent's workspaces", async () => {
    expect((await call("get_file", { fileId: "other" })).isError).toBe(true);
  });
});
