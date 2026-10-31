import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Op } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), apply: vi.fn(), theme: vi.fn(), nodes: vi.fn(), own: vi.fn(), loadFrame: vi.fn(), capture: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({
    apply: mocks.apply, theme: mocks.theme, nodes: mocks.nodes,
    node: async (id: string) => (await mocks.nodes()).find((node: CanvasNode) => node.id === id),
    outline: async () => [{ id: "page", name: "Feature", sort: 0, nodes: await mocks.nodes() }],
    pages: async () => [{ id: "page", name: "Feature", sort: 0 }], peers: async () => [],
    cover: async () => ({ nodeId: null, url: null }), agentActivity: async () => {}, instances: async () => [],
    designSystem: async () => ({ tokens: '@theme { --color-primary: blue; } .dark {} [data-theme="UwU"] {}', components: [], library: null, fileTheme: await mocks.theme() }),
    ownDesignSystem: async () => (await mocks.own()) ?? { tokens: "", components: [] },
  }),
}));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: async () => ({ newPage: async () => ({}), close: async () => {} }) } }));
vi.mock("./render", () => ({ loadFrame: mocks.loadFrame, capture: mocks.capture }));
import { mcp } from "./mcp";

let fileTheme: string | null;
let scopes: string[];
const node = (id: string, patch: Partial<CanvasNode & { source: string }> = {}) => ({
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
  fileTheme = "dark";
  scopes = ["sharpner:read", "sharpner:write"];
  mocks.authenticate.mockImplementation(async () => ({ user: { id: "alice", name: "Alice", avatar_url: null }, method: "oauth", scopes }));
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "file" ? { id, name: "Example", library_id: null } : null);
  mocks.theme.mockImplementation(async () => fileTheme);
  mocks.nodes.mockResolvedValue([node("inherited"), node("override", { theme: "light" }), node("tokens", { kind: "tokens" }), node("component", { kind: "component" })]);
  mocks.apply.mockImplementation(async (_file: string, _origin: string, ops: Op[]) => {
    for (const op of ops) if (op.t === "theme.set") fileTheme = op.theme;
  });
  mocks.loadFrame.mockResolvedValue({ width: 400, height: 600 });
  mocks.capture.mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("agent theme controls", () => {
  it("creates component theme overrides and lists them with their component", async () => {
    mocks.nodes.mockResolvedValue([
      node("button", { kind: "component", name: "Button/Primary", source: "<button>{{label|Go}}</button>" }),
      node("sakura-button", { kind: "component", name: "Button/Primary", theme: "sakura", source: "<button>✿ {{label|Go}} {{petals|3}}</button>" }),
    ]);
    mocks.own.mockResolvedValue({ tokens: "", components: [
      { tag: "x-button-primary", html: "<button>{{label|Go}}</button>", theme: null },
      { tag: "x-button-primary", html: "<button>✿ {{label|Go}} {{petals|3}}</button>", theme: "sakura" },
    ] });
    const { components } = (await call("get_design_system", { fileId: "file" })).value;
    expect(components).toHaveLength(1);
    expect(components[0]).toMatchObject({ tag: "x-button-primary", nodeId: "button", themeOverrides: [{ theme: "sakura", nodeId: "sakura-button" }] });
    expect(components[0]).not.toHaveProperty("missingDefault");
    expect((await call("read_nodes", { fileId: "file", nodeIds: ["sakura-button", "button"] })).value.map((n: { theme?: string }) => n.theme)).toEqual(["sakura", undefined]);

    await call("create_nodes", { fileId: "file", nodes: [{ kind: "component", name: "Card", source: "<div>✿</div>", theme: "sakura" }] });
    expect(mocks.apply.mock.calls.at(-1)![2]).toMatchObject([{ t: "node.put", node: { kind: "component", name: "Card", theme: "sakura" } }]);
    // Its specimen renders in its own theme, whatever the file uses.
    await call("screenshot_nodes", { fileId: "file", nodeIds: ["sakura-button", "button"] });
    expect(mocks.loadFrame.mock.calls.map(([, frame]) => [frame.id, frame.theme])).toEqual([["sakura-button", "sakura"], ["button", "dark"]]);
  });

  it("exposes file selection, discovered names, and effective screen themes", async () => {
    const file = (await call("get_file", { fileId: "file" })).value;
    expect(file.fileTheme).toBe("dark");
    expect(file.pages[0].nodes.slice(0, 2)).toMatchObject([
      { id: "inherited", theme: null, effectiveTheme: "dark" }, { id: "override", theme: "light", effectiveTheme: "light" },
    ]);
    expect((await call("read_nodes", { fileId: "file", nodeIds: ["override"] })).value[0]).toMatchObject({ theme: "light", effectiveTheme: "light" });
    expect((await call("get_design_system", { fileId: "file" })).value).toMatchObject({ fileTheme: "dark", themes: ["light", "dark", "UwU"] });
  });

  it("sets and resets the file theme, and accepts frame overrides in create and update", async () => {
    expect((await call("set_theme", { fileId: "file", theme: "UwU" })).value).toEqual({ ok: true, fileTheme: "UwU" });
    expect((await call("set_theme", { fileId: "file", theme: null })).value).toEqual({ ok: true, fileTheme: null });
    await call("create_nodes", { fileId: "file", nodes: [{ name: "New screen", source: "<main>New</main>", theme: "light" }] });
    expect(mocks.apply.mock.calls.at(-1)![2]).toMatchObject([{ t: "node.put", node: { kind: "frame", theme: "light" } }]);
    await call("update_nodes", { fileId: "file", updates: [{ nodeId: "override", theme: null }] });
    expect(mocks.apply.mock.calls.at(-1)![2]).toEqual([{ t: "node.put", id: "override", node: { theme: null } }]);
  });

  it("screenshots resolve the same inheritance as live frames and leave foundation panes alone", async () => {
    const result = await call("screenshot_nodes", { fileId: "file", nodeIds: ["inherited", "override", "tokens", "component"] });
    expect(result.isError).not.toBe(true);
    expect(mocks.loadFrame.mock.calls.map(([, frame]) => [frame.id, frame.theme])).toEqual([
      ["inherited", "dark"], ["override", "light"], ["tokens", undefined], ["component", "dark"],
    ]);
  });

  it("enforces write scope and workspace membership before applying file themes", async () => {
    scopes = ["sharpner:read"];
    expect((await call("get_file", { fileId: "file" })).value.fileTheme).toBe("dark");
    expect((await call("set_theme", { fileId: "file", theme: "light" })).isError).toBe(true);
    scopes.push("sharpner:write");
    expect((await call("set_theme", { fileId: "other-file", theme: "light" })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });

  it.each([undefined, "", "  ", "x".repeat(81), "dark\ninvalid"])("rejects invalid choices: %j", async (theme) => {
    expect((await call("set_theme", { fileId: "file", theme })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
