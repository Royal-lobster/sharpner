import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode, Op, Page } from "../shared/types";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), fileFor: vi.fn(), apply: vi.fn(), outline: vi.fn() }));
vi.mock("./auth", async (original) => ({ ...await original<typeof import("./auth")>(), authenticate: mocks.authenticate }));
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), fileFor: mocks.fileFor,
  room: () => ({
    apply: mocks.apply, outline: mocks.outline, peers: async () => [],
    pages: async () => (await mocks.outline()).map(({ nodes: _nodes, ...page }: Page & { nodes: CanvasNode[] }) => page),
  }),
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
  }, {} as Env);
  const { result } = await response.json() as { result: { content: { text: string }[]; isError?: boolean; tools?: { name: string }[] } };
  return { ...result, value: result.content?.[0] && !result.isError ? JSON.parse(result.content[0].text) : undefined };
}
const applied = () => mocks.apply.mock.calls.flatMap((args) => args[2] as Op[]);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ user, method: "oauth", scopes: ["sharpner:read", "sharpner:write"] });
  mocks.fileFor.mockResolvedValue({ id: "file", name: "tupredices", library_id: null });
  mocks.outline.mockResolvedValue(outline);
});

describe("page and section descriptions for agents", () => {
  it("advertises a table of contents and page updates", async () => {
    const names = (await call("tools/list", {})).tools!.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_pages", "update_page", "create_page", "get_file"]));
    expect(names).not.toContain("rename_page");
  });

  it("lists pages and sections with their descriptions and direct design counts, and flags missing ones", async () => {
    const { value } = await call("list_pages", { fileId: "file" });
    expect(value.pages).toEqual([
      { id: "ds", name: "Design System", description: outline[0]!.description, designs: 3, sections: [
        { id: "tokens", name: "tokens", description: "The file's one token sheet.", parentId: null, designs: 1 },
        { id: "components", name: "components", description: "", parentId: null, designs: 0 },
        { id: "forms", name: "forms", description: "Inputs and validation states.", parentId: "components", designs: 2 },
      ] },
      { id: "screens", name: "Screens", description: "", designs: 1, sections: [] },
    ]);
    expect(value.hint).toMatch(/no description/);
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
