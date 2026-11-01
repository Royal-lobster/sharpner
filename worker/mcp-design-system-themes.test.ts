import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBrand, type CanvasNode } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), apply: vi.fn(), nodes: vi.fn(), own: vi.fn(), screenshot: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({
    brand: async () => emptyBrand(), catalog: async () => ({ brand: emptyBrand(), pageId: null, primitives: [], tokenSheets: 0 }),
      apply: mocks.apply, nodes: mocks.nodes, screenshotNodes: mocks.screenshot,
    node: async (id: string) => (await mocks.nodes()).find((node: CanvasNode) => node.id === id),
    outline: async () => [{ id: "page", name: "Feature", sort: 0, nodes: await mocks.nodes() }],
    pages: async () => [{ id: "page", name: "Feature", sort: 0 }], peers: async () => [],
    cover: async () => ({ nodeId: null, url: null }), agentActivity: async () => {}, instances: async () => [],
    designSystem: async () => ({ tokens: '@theme { --color-primary: blue; } .dark {} [data-theme="UwU"] {}', components: [], library: null }),
    ownDesignSystem: async () => (await mocks.own()) ?? { tokens: "", components: [] },
  }),
}));
import { mcp } from "./mcp";

let scopes: string[];
const node = (id: string, patch: Partial<CanvasNode & { source: string }> & Record<string, unknown> = {}) => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0, width: 400, height: 600,
  measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, source: "<main>Screen</main>", ...patch,
});

async function call(name: string, args: unknown) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  }, { BROWSER: {} } as unknown as Env);
  const { result } = await response.json() as { result: { isError?: boolean; content: { type: string; text?: string }[] } };
  return { ...result, value: result.content?.[0]?.text && !result.isError && name !== "screenshot_nodes" ? JSON.parse(result.content[0].text) : undefined };
}

beforeEach(() => {
  vi.resetAllMocks();
  scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user: { id: "alice", name: "Alice", avatar_url: null }, method: "oauth", scopes }));
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "file" ? { id, name: "Example", library_id: null } : null);
  mocks.nodes.mockResolvedValue([node("inherited"), node("override"), node("tokens", { kind: "tokens" }), node("component", { kind: "component" })]);
  mocks.screenshot.mockResolvedValue({ content: [{type:"image", data:"AQID", mimeType:"image/jpeg"}] });
});

describe("agent theme model", () => {
  it("lists one definition per component tag with no theme overrides", async () => {
    mocks.nodes.mockResolvedValue([node("button", { kind: "component", name: "Button/Primary", source: "<button>{{label|Go}}</button>" })]);
    mocks.own.mockResolvedValue({ tokens: "", components: [{ tag: "x-button-primary", html: "<button>{{label|Go}}</button>" }] });
    const { components } = (await call("get_design_system", { fileId: "file" })).value;
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ tag: "x-button-primary", nodeId: "button" });
    expect(components[0]).not.toHaveProperty("themeOverrides");
    expect(components[0]).not.toHaveProperty("missingDefault");
  });

  it("omits theme from node outputs and still lists declared theme names", async () => {
    const file = (await call("get_file", { fileId: "file" })).value;
    expect(file).not.toHaveProperty("fileTheme");
    for (const n of file.pages[0].nodes) { expect(n).not.toHaveProperty("theme"); expect(n).not.toHaveProperty("effectiveTheme"); }
    for (const n of (await call("read_nodes", { fileId: "file", nodeIds: ["inherited", "component"] })).value) expect(n).not.toHaveProperty("theme");
    expect((await call("get_design_system", { fileId: "file" })).value).toMatchObject({ themes: ["light", "dark", "UwU"] });
  });

  it("has no set_theme tool and ignores a stray theme input", async () => {
    expect((await call("set_theme", { fileId: "file", theme: "UwU" })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
    await call("create_nodes", { fileId: "file", nodes: [{ name: "New screen", source: "<main>New</main>", theme: "light" }] });
    const created = mocks.apply.mock.calls.at(-1)![2][0].node;
    expect(created).toMatchObject({ kind: "frame" });
    expect(created).not.toHaveProperty("theme");
    await call("update_nodes", { fileId: "file", updates: [{ nodeId: "override", name: "Renamed", theme: "dark" }] });
    expect(mocks.apply.mock.calls.at(-1)![2]).toEqual([{ t: "node.put", id: "override", node: { name: "Renamed" } }]);
  });

  it("forwards screenshots through the room browser slot and preserves image responses", async () => {
    const result = await call("screenshot_nodes", { fileId: "file", nodeIds: ["inherited", "override", "tokens", "component"] });
    expect(result.isError).not.toBe(true);
    expect(mocks.screenshot).toHaveBeenCalledWith(["inherited", "override", "tokens", "component"], "https://sharpner.example");
    expect(result.content).toEqual([{type:"image",data:"AQID",mimeType:"image/jpeg"}]);
  });
});
