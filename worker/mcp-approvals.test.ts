import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, CanvasNode } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), approve: vi.fn(), approvals: vi.fn(), node: vi.fn(), apply: vi.fn(), order: [] as string[] }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({ approve: mocks.approve, approvals: mocks.approvals, node: mocks.node, apply: mocks.apply, agentActivity: async () => {},
    nodes: async () => [frame, component], outline: async () => [{ id: "page", name: "Screens", sort: 0, nodes: [frame] }],
    cover: async () => ({ nodeId: null, url: null }) }),
}));
import { mcp } from "./mcp";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const actor: Actor = { id: "alice", name: "Alice's agent", avatar: null, agent: true };
const frame = { id: "home", pageId: "page", parentId: null, kind: "frame", name: "Home", x: 0, y: 0, order: 1, width: 390, height: 800,
  measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 2,
  createdAt: Date.UTC(2026, 10, 1), changedAt: Date.UTC(2026, 10, 3) } as CanvasNode;
const component = { ...frame, id: "button", kind: "component", name: "Button" } as CanvasNode;
let scopes: string[];

async function call(name: string, args: unknown) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, {} as Env);
  const { result } = await response.json() as { result: { content: { text: string }[]; isError?: boolean } };
  return { ...result, data: result.isError ? null : JSON.parse(result.content[0]!.text) };
}

beforeEach(() => {
  vi.resetAllMocks(); scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user, method: "oauth", scopes }));
  mocks.fileFor.mockResolvedValue({ id: "file", name: "App", workspace_id: "acme" });
  mocks.approvals.mockResolvedValue([]);
  mocks.node.mockResolvedValue({ ...frame, source: "<main/>" });
  mocks.order.length = 0;
  mocks.apply.mockImplementation(async () => { mocks.order.push("apply"); });
});
const approve = (updates: unknown[]) => call("update_nodes", { fileId: "file", updates });

describe("agent approvals", () => {
  it("approves frames for the member with agent attribution, and withdraws them, without a canvas edit", async () => {
    mocks.approve.mockResolvedValue([{ nodeId: "home", approvedAt: Date.UTC(2026, 10, 4), approvedBy: actor }]);
    const approved = await approve([{ nodeId: "home", approved: true }]);
    expect(mocks.approve).toHaveBeenCalledWith("file", ["home"], true, actor);
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(approved.data).toEqual({ ok: true, updated: 1, approvals: [{ nodeId: "home", approvedAt: "2026-11-04T00:00:00.000Z", approvedBy: "Alice's agent" }] });
    mocks.approve.mockResolvedValue([]);
    expect((await approve([{ nodeId: "home", approved: false }])).data).toEqual({ ok: true, updated: 1 });
    expect(mocks.approve).toHaveBeenLastCalledWith("file", ["home"], false, actor);
  });

  it("approves after the call's edits, so the approval covers the edited frame", async () => {
    mocks.approve.mockImplementation(async () => { mocks.order.push("approve"); return []; });
    await approve([{ nodeId: "home", source: "<main>New</main>", approved: true }]);
    expect(mocks.apply).toHaveBeenCalledWith("file", "https://sharpner.example", [{ t: "node.put", id: "home", node: { source: "<main>New</main>" } }], actor);
    expect(mocks.order).toEqual(["apply", "approve"]);
  });

  it("refuses non-frames before changing anything", async () => {
    const result = await approve([{ nodeId: "home", source: "<main/>" }, { nodeId: "button", approved: true }]);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Only frames can be approved: Button");
    expect(mocks.apply).not.toHaveBeenCalled();
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("blocks read-only connections and files outside the member's workspaces", async () => {
    scopes = ["sharpner:read"];
    expect((await approve([{ nodeId: "home", approved: true }])).isError).toBe(true);
    scopes = ["sharpner:read", "sharpner:write"];
    mocks.fileFor.mockResolvedValue(null);
    expect((await approve([{ nodeId: "home", approved: true }])).isError).toBe(true);
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("shows design dates and whether an approved frame changed since", async () => {
    expect((await call("get_file", { fileId: "file" })).data.pages[0].nodes[0]).toMatchObject({
      createdAt: "2026-11-01T00:00:00.000Z", changedAt: "2026-11-03T00:00:00.000Z" });
    mocks.approvals.mockResolvedValue([{ nodeId: "home", approvedAt: Date.UTC(2026, 10, 2), approvedBy: { ...actor, name: "Alice", agent: false } }]);
    const [read] = (await call("read_nodes", { fileId: "file", nodeIds: ["home"] })).data;
    expect(read.approval).toEqual({ nodeId: "home", approvedAt: "2026-11-02T00:00:00.000Z", approvedBy: "Alice", changedSinceApproval: true });
    mocks.node.mockResolvedValue({ ...frame, source: "<main/>", createdAt: null, changedAt: null });
    const [undated] = (await call("read_nodes", { fileId: "file", nodeIds: ["home"] })).data;
    expect(undated).not.toHaveProperty("createdAt");
    expect(undated.approval.changedSinceApproval).toBe(false);
  });
});
