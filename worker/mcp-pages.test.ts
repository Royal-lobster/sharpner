import { beforeEach, describe, expect, it, vi } from "vitest";
import { componentTag, emptyBrand, type CanvasNode, type Op, type Page } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), apply: vi.fn(), outline: vi.fn(), instances: vi.fn(), dependents: vi.fn(), brand: vi.fn(), catalog: vi.fn(), library: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: (_env: Env, id: string) => {
    const outline = async () => (await mocks.outline(id)) as (Page & { nodes: CanvasNode[] })[];
    return {
      brand: async () => mocks.brand(id), catalog: async () => mocks.catalog(id),
      apply: mocks.apply, outline, peers: async () => [], instances: () => mocks.instances(id),
      cover: async () => ({ nodeId: null, url: null }),
      theme: async () => null,
      pages: async () => (await outline()).map(({ nodes: _nodes, ...page }) => page),
      nodes: async () => (await outline()).flatMap((p) => p.nodes),
      designSystem: async () => ({ tokens: "", components: [], library: mocks.library(), fileTheme: null }),
      ownDesignSystem: async () => ({ tokens: "", components: (await outline()).flatMap((p) => p.nodes).filter((n) => n.kind === "component").map((n) => ({ tag: componentTag(n.name), html: "", theme: n.theme })) }),
    };
  },
}));
import { mcp } from "./mcp";

const user = { id: "alice", login: "alice", name: "Alice", avatar_url: null };
const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "ds", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const outline = [
  { id: "ds", name: "Design System", sort: 0, description: "Token sheet and component catalogs. Check before building screens.", nodes: [
    node("tokens", { kind: "section", layout: "auto", description: "The file's one token sheet." }),
    node("sheet", { kind: "tokens", parentId: "tokens" }),
    node("components", { kind: "section", layout: "auto" }),
    node("forms", { kind: "section", layout: "auto", parentId: "components", description: "Inputs and validation states." }),
    node("field", { kind: "component", name: "Field", parentId: "forms" }),
    node("select", { kind: "component", name: "Select", parentId: "forms" }),
  ] },
  { id: "screens", name: "Screens", sort: 1, description: "", nodes: [node("home", { pageId: "screens" })] },
];

async function call(name: string, args: unknown) {
  const response = await mcp.request("https://sharpner.example/", { method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: name === "tools/list" ? name : "tools/call", params: name === "tools/list" ? {} : { name, arguments: args } }),
  }, { DB: { prepare: () => ({ bind: () => ({ all: async () => ({ results: mocks.dependents() }) }) }) } } as unknown as Env);
  const { result } = await response.json() as { result: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  return { ...result, value: result.content?.[0] && !result.isError ? JSON.parse(result.content[0].text) : undefined };
}
const applied = () => mocks.apply.mock.calls.flatMap((args) => args[2] as Op[]);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user, method: "oauth", scopes: ["sharpner:read", "sharpner:write"] });
  mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => ({ id, name: id === "file" ? "tupredices" : id, library_id: null }));
  mocks.outline.mockResolvedValue(outline);
  mocks.instances.mockReturnValue([]);
  mocks.dependents.mockReturnValue([]);
  mocks.brand.mockReturnValue(emptyBrand());
  mocks.catalog.mockReturnValue({ brand: emptyBrand(), pageId: null, primitives: [], tokenSheets: 0 });
  mocks.library.mockReturnValue(null);
});

describe("page and section descriptions for agents", () => {
  it("advertises page updates without the removed rename_page alias", async () => {
    const names = (await call("tools/list", {})).tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_pages", "update_page", "create_page", "get_file"]));
    expect(names).not.toContain("rename_page");
    expect((await call("rename_page", { fileId: "file", pageId: "ds", name: "Old alias" })).isError).toBe(true);
    expect(applied()).toEqual([]);
    await call("update_page", { fileId: "file", pageId: "ds", name: "Foundations" });
    expect(applied()).toEqual([{ t: "page.put", page: { id: "ds", name: "Foundations", sort: 0 } }]);
  });

  it("lists pages and sections with their descriptions and direct design counts, and flags missing ones", async () => {
    const { value } = await call("list_pages", { fileId: "file" });
    expect(value.pages).toEqual([
      { id: "ds", name: "Design System", description: outline[0]!.description, arrangement: "tiled", designs: 3, sections: [
        { id: "tokens", name: "tokens", description: "The file's one token sheet.", parentId: null, designs: 1 },
        { id: "components", name: "components", description: "", parentId: null, designs: 0 },
        { id: "forms", name: "forms", description: "Inputs and validation states.", parentId: "components", designs: 2 },
      ] },
      { id: "screens", name: "Screens", description: "", arrangement: "manual", designs: 1, sections: [] },
    ]);
    expect(value.hint).toMatch(/no description/);
  });

  it("says when hand-placed content keeps a page's automatic sections in one column", async () => {
    mocks.outline.mockResolvedValue([{ ...outline[0]!, nodes: [...outline[0]!.nodes,
      node("placed", { kind: "section", layout: "free", name: "Components (placed)" }), node("loose-1"), node("loose-2")] }]);
    const page = (await call("list_pages", { fileId: "file" })).value.pages[0];
    expect(page).toMatchObject({ arrangement: "stacked", stackedBy: [
      { id: "placed", name: "Components (placed)", kind: "section" }, { id: "loose-1", name: "loose-1", kind: "frame" }, { id: "loose-2", name: "loose-2", kind: "frame" },
    ] });
    expect(page.reason).toBe('Automatic sections stay in one column because of free section "Components (placed)" and 2 loose nodes. Set those sections to layout "auto", or move loose nodes into a section, to let the page tile.');
    expect((await call("get_file", { fileId: "file", pageId: "ds" })).value.pages[0]).toMatchObject({ arrangement: "stacked", reason: page.reason });
  });

  it("reads a single page with descriptions, and rejects an unknown page", async () => {
    const { value } = await call("get_file", { fileId: "file", pageId: "ds" });
    expect(value.pages.map((p: Page) => p.id)).toEqual(["ds"]);
    expect(value.pages[0]).toMatchObject({ description: outline[0]!.description });
    expect(value.pages[0].sections.find((s: { id: string }) => s.id === "forms")).toMatchObject({ description: "Inputs and validation states.", parentId: "components" });
    expect((await call("get_file", { fileId: "file", pageId: "missing" })).isError).toBe(true);
    expect((await call("get_file", { fileId: "file" })).value.pages).toHaveLength(2);
  });

  it("writes descriptions when creating pages and sections", async () => {
    await call("create_page", { fileId: "file", name: "Flows", description: "Onboarding and checkout flows." });
    await call("create_section", { fileId: "file", pageId: "screens", name: "Onboarding", description: "Sign-up to first market." });
    const [page, section] = applied();
    expect(page).toMatchObject({ t: "page.put", page: { name: "Flows", sort: 2, description: "Onboarding and checkout flows." } });
    expect(section).toMatchObject({ t: "node.put", node: { kind: "section", name: "Onboarding", description: "Sign-up to first market." } });
  });

  it("renames without touching the description, and describes or clears it on request", async () => {
    await call("update_page", { fileId: "file", pageId: "ds", name: "Foundations" });
    await call("update_page", { fileId: "file", pageId: "screens", description: "Every product screen, one section per flow." });
    await call("update_page", { fileId: "file", pageId: "ds", description: "" });
    expect(applied()).toEqual([
      { t: "page.put", page: { id: "ds", name: "Foundations", sort: 0 } },
      { t: "page.put", page: { id: "screens", name: "Screens", sort: 1, description: "Every product screen, one section per flow." } },
      { t: "page.put", page: { id: "ds", name: "Design System", sort: 0, description: "" } },
    ]);
    expect((await call("update_page", { fileId: "file", pageId: "ds", description: "x".repeat(501) })).isError).toBe(true);
  });
});

describe("component usage", () => {
  const use = (tag: string, id: string, kind: "frame" | "component" = "frame", pageId = "screens") => ({ tag, id, name: id, kind, pageId });

  it("counts direct uses per component in get_design_system", async () => {
    mocks.instances.mockReturnValue([use("x-field", "home"), use("x-field", "select", "component", "ds"), use("x-select", "home")]);
    const { value } = await call("get_design_system", { fileId: "file" });
    expect(value.components.map((c: { tag: string; uses: number }) => [c.tag, c.uses])).toEqual([["x-field", 2], ["x-select", 1]]);
  });

  it("finds instances in the file and in accessible files using it as a library, unless they override the tag", async () => {
    mocks.dependents.mockReturnValue([{ id: "app" }, { id: "private" }, { id: "fork" }]);
    mocks.fileFor.mockImplementation(async (_env: Env, _user: string, id: string) => id === "private" ? null : { id, name: id === "file" ? "tupredices" : id, library_id: null });
    mocks.outline.mockImplementation(async (id: string) => id === "fork"
      ? [{ id: "p", name: "P", sort: 0, nodes: [node("own", { kind: "component", name: "Field", pageId: "p" })] }]
      : id === "app" ? [{ id: "flows", name: "Flows", sort: 0, nodes: [] }] : outline);
    mocks.instances.mockImplementation((id: string) => id === "file" ? [use("x-field", "home"), use("x-field-label", "home")]
      : id === "app" ? [use("x-field", "signup", "frame", "flows")] : [use("x-field", "forked", "frame", "p")]);
    const { value } = await call("find_instances", { fileId: "file", component: "Field" });
    expect(value).toEqual({ tag: "x-field", total: 2, instances: [
      { fileId: "file", fileName: "tupredices", pageId: "screens", pageName: "Screens", nodeId: "home", name: "home", kind: "frame" },
      { fileId: "app", fileName: "app", pageId: "flows", pageName: "Flows", nodeId: "signup", name: "signup", kind: "frame" },
    ] });
    expect((await call("find_instances", { fileId: "file", component: "<x-field>" })).value.total).toBe(2);
  });
});

describe("moving nodes between pages", () => {
  it("lands free sections and loose nodes right of the target page's content, without stacking them", async () => {
    mocks.outline.mockResolvedValue([outline[0]!, { ...outline[1]!, nodes: [
      node("home", { pageId: "screens" }),
      node("auto", { pageId: "screens", kind: "section", layout: "auto", x: 0, y: 900 }),
    ] }, { id: "extra", name: "Extra", sort: 2, nodes: [node("free", { pageId: "extra", kind: "section", layout: "free" }), node("inside", { pageId: "extra", parentId: "free", x: 4000, y: 4000 })] }]);
    await call("update_nodes", { fileId: "file", updates: [
      { nodeId: "tokens", pageId: "screens", sectionId: null },
      { nodeId: "free", pageId: "screens", sectionId: null },
      { nodeId: "sheet", pageId: "screens", sectionId: null, x: 10, y: 20 },
    ] });
    const [tokens, free, sheet] = applied() as Extract<Op, { t: "node.put" }>[];
    // "tokens" is an automatic section: it joins the page's arrangement, so its position is left alone.
    expect(tokens!.node).not.toHaveProperty("x");
    // Right of the page's widest content: the 480 px empty automatic section.
    const right = 480 + 160;
    expect(free!.node).toMatchObject({ x: right, y: 0 });
    expect(sheet!.node).toMatchObject({ x: 10, y: 20 });
    await call("update_nodes", { fileId: "file", updates: [{ nodeId: "free", pageId: "screens" }, { nodeId: "home", pageId: "extra" }, { nodeId: "field", pageId: "screens", sectionId: null }] });
    const [, , , again, home, field] = applied() as Extract<Op, { t: "node.put" }>[];
    expect(again!.node).toMatchObject({ x: right, y: 0 });
    expect(home!.node).toMatchObject({ x: 4000 + 400 + 128 + 160, y: 4000 - 128 });
    // A second arrival lands beside the first instead of on top of it.
    expect(field!.node.x).toBeGreaterThan(again!.node.x! + 400);
  });
});



describe("agent Design System documents and Brand", () => {
  it("creates and converts document pages without changing nodes", async () => {
    await call("create_page", { fileId: "file", name: "Design System", kind: "design-system" });
    await call("update_page", { fileId: "file", pageId: "ds", kind: "design-system" });
    await call("update_page", { fileId: "file", pageId: "ds", kind: "canvas" });
    expect(applied()).toMatchObject([
      { t: "page.put", page: { kind: "design-system" } },
      { t: "page.put", page: { id: "ds", kind: "design-system" } },
      { t: "page.put", page: { id: "ds", kind: "canvas" } },
    ]);
    expect((await call("update_page", { fileId: "file", pageId: "ds", kind: "other" })).isError).toBe(true);
  });

  it("reports document kind, Brand and primitive locations and patches only requested fields", async () => {
    mocks.outline.mockResolvedValue([{ ...outline[0]!, kind: "design-system" }, outline[1]!]);
    mocks.brand.mockReturnValue({ ...emptyBrand(), name: "FraxNet", voice: ["Plain verbs"] });
    const system = (await call("get_design_system", { fileId: "file" })).value;
    expect(system).toMatchObject({ brand: { name: "FraxNet", voice: ["Plain verbs"] }, designSystemPageId: "ds", components: [{ primitive: true, pageId: "ds" }, { primitive: true, pageId: "ds" }] });
    expect((await call("list_pages", { fileId: "file" })).value.pages[0]).toMatchObject({ kind: "design-system", arrangement: "document" });
    expect((await call("get_file", { fileId: "file", pageId: "ds" })).value.pages[0]).toMatchObject({ kind: "design-system", arrangement: "document" });
    await call("set_brand", { fileId: "file", guidelines: "Paper and ink." });
    expect(applied()).toEqual([{ t: "brand.set", brand: { guidelines: "Paper and ink." } }]);
    await call("create_nodes", { fileId: "file", pageId: "ds", nodes: [{ kind: "component", name: "Button/Default", source: "<button>Go</button>" }] });
    expect(applied().at(-1)).toMatchObject({ t: "node.put", node: { pageId: "ds", kind: "component" } });
  });

  it("returns inherited Brand and primitives, with local tag replacement and source labels", async () => {
    const inherited = [{ id: "lib-ds", name: "Library system", kind: "design-system", sort: 0, nodes: [node("lib-field", { pageId: "lib-ds", kind: "component", name: "Field" }), node("lib-button", { pageId: "lib-ds", kind: "component", name: "Button/Default" })] }];
    mocks.library.mockReturnValue({ fileId: "library", name: "fraxnet" });
    mocks.outline.mockImplementation(async (id: string) => id === "library" ? inherited : [{ ...outline[0]!, kind: "design-system" }, outline[1]!]);
    mocks.catalog.mockReturnValue({ brand: { ...emptyBrand(), name: "FraxNet", voice: ["Direct"] }, pageId: "lib-ds", primitives: inherited[0]!.nodes, tokenSheets: 1 });
    const system = (await call("get_design_system", { fileId: "file" })).value;
    expect(system.libraryCatalog).toEqual({ brand: { ...emptyBrand(), name: "FraxNet", voice: ["Direct"] }, designSystemPageId: "lib-ds" });
    expect(system.components.filter((c: { tag: string }) => c.tag === "x-field")).toMatchObject([{ source: "file", nodeId: "field" }]);
    expect(system.components.find((c: { tag: string }) => c.tag === "x-button-default")).toMatchObject({ primitive: true, source: "library", libraryFileId: "library", pageId: "lib-ds" });
    await call("set_brand", { fileId: "file", name: "Product" });
    expect(mocks.apply.mock.calls.at(-1)![0]).toBe("file");
  });

  it("enforces membership and write scope for Brand and page conversion", async () => {
    mocks.authenticate.mockResolvedValue({ user, method: "oauth", scopes: ["sharpner:read"] });
    expect((await call("get_design_system", { fileId: "file" })).isError).not.toBe(true);
    expect((await call("set_brand", { fileId: "file", name: "Denied" })).isError).toBe(true);
    expect((await call("update_page", { fileId: "file", pageId: "ds", kind: "design-system" })).isError).toBe(true);
    mocks.authenticate.mockResolvedValue({ user, method: "oauth", scopes: ["sharpner:read", "sharpner:write"] });
    mocks.fileFor.mockResolvedValue(null);
    expect((await call("set_brand", { fileId: "other", name: "Denied" })).isError).toBe(true);
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
