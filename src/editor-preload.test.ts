import { runInNewContext } from "node:vm";
import type { HtmlTagDescriptor, IndexHtmlTransformContext, IndexHtmlTransformHook, ResolvedConfig } from "vite";
import { describe, expect, it, vi } from "vitest";
import { editorPreload } from "../vite.editor-preload";

type Bundle = NonNullable<IndexHtmlTransformContext["bundle"]>;
const graph = () => ({
  "assets/index-entry.js": { type: "chunk", fileName: "assets/index-entry.js", facadeModuleId: "/app/src/main.tsx", imports: ["assets/shared.js"], dynamicImports: ["assets/Editor-hashed.js", "assets/Landing-hashed.js"] },
  "assets/shared.js": { type: "chunk", fileName: "assets/shared.js", facadeModuleId: null, imports: [], dynamicImports: [] },
  "assets/Editor-hashed.js": { type: "chunk", fileName: "assets/Editor-hashed.js", facadeModuleId: "/app/src/Editor.tsx", imports: ["assets/index-entry.js", "assets/shared.js", "assets/canvas-hashed.js", "assets/drawer-hashed.js", "assets/canvas-hashed.js"], dynamicImports: ["assets/settings-hashed.js", "assets/Landing-hashed.js"] },
  "assets/canvas-hashed.js": { type: "chunk", fileName: "assets/canvas-hashed.js", facadeModuleId: null, imports: ["assets/math-hashed.js"], dynamicImports: [] },
  "assets/math-hashed.js": { type: "chunk", fileName: "assets/math-hashed.js", facadeModuleId: null, imports: ["assets/canvas-hashed.js"], dynamicImports: [] },
  "assets/drawer-hashed.js": { type: "chunk", fileName: "assets/drawer-hashed.js", facadeModuleId: null, imports: [], dynamicImports: [] },
  "assets/settings-hashed.js": { type: "chunk", fileName: "assets/settings-hashed.js", facadeModuleId: "/app/src/AgentSettings.tsx", imports: [], dynamicImports: [] },
  "assets/Landing-hashed.js": { type: "chunk", fileName: "assets/Landing-hashed.js", facadeModuleId: "/app/src/Landing.tsx", imports: [], dynamicImports: [] },
}) as unknown as Bundle;

async function transform(base = "/", bundle: Bundle | null = graph(), html = `<script type="module" src="${base}assets/index-entry.js"></script><link rel="modulepreload" href="${base}assets/shared.js">`) {
  const plugin = editorPreload();
  const configure = plugin.configResolved as (config: ResolvedConfig) => void;
  configure({ base } as ResolvedConfig);
  const hook = plugin.transformIndexHtml as { order: string; handler: IndexHtmlTransformHook };
  expect(plugin.apply).toBe("build");
  expect(hook.order).toBe("post");
  return await hook.handler.call({} as never, html, { path: "/index.html", filename: "/app/index.html", bundle: bundle ?? undefined }) as HtmlTagDescriptor[];
}

function run(tags: HtmlTagDescriptor[], pathname: string) {
  const append = vi.fn();
  for (const tag of tags) {
    expect(tag.tag).toBe("script");
    expect(tag.injectTo).toBe("head");
    expect(typeof tag.children).toBe("string");
    runInNewContext(tag.children as string, {
      location: { pathname },
      document: { createElement: () => ({}), head: { append } },
    });
  }
  return append.mock.calls.map(([link]) => link as { href: string; rel: string; crossOrigin: string });
}

describe("early direct-file editor module preloads", () => {
  it.each(["/f/file_a", "/f/file-a-1/", `/s/${"A".repeat(43)}`, `/s/${"a_-".repeat(14)}x/`])("starts the emitted editor and all static dependencies for %s", async (path) => {
    const links = run(await transform(), path);
    expect(links.map((link) => link.href)).toEqual([
      "/assets/Editor-hashed.js", "/assets/canvas-hashed.js", "/assets/math-hashed.js", "/assets/drawer-hashed.js",
    ]);
    expect(links.every((link) => link.rel === "modulepreload" && link.crossOrigin === "anonymous")).toBe(true);
  });

  it.each(["/", "/sign-in", "/f/", "/f/file_a/extra", "/f/file.a", "//f/file_a", `/s/${"A".repeat(42)}`, `/s/${"A".repeat(44)}`, `/s/${"A".repeat(43)}/extra`, `/s/${"!".repeat(43)}`])("keeps editor downloads off unrelated or invalid route %s", async (path) => {
    expect(run(await transform(), path)).toEqual([]);
  });

  it.each(["/sharpner/", "https://cdn.example/app/", "./"])("respects Vite asset base %s", async (base) => {
    expect(run(await transform(base), "/f/file_a").map((link) => link.href)).toEqual([
      `${base}assets/Editor-hashed.js`, `${base}assets/canvas-hashed.js`, `${base}assets/math-hashed.js`, `${base}assets/drawer-hashed.js`,
    ]);
  });

  it("uses actual emitted names, traverses static cycles once, and excludes dynamic chunks", async () => {
    const bundle = graph();
    const editor = bundle["assets/Editor-hashed.js"]!;
    delete bundle["assets/Editor-hashed.js"];
    editor.fileName = "assets/Editor-another-build.js";
    bundle[editor.fileName] = editor;
    const links = run(await transform("/", bundle), "/f/file_a").map((link) => link.href);
    expect(links[0]).toBe("/assets/Editor-another-build.js");
    expect(new Set(links).size).toBe(links.length);
    expect(links.some((href) => /settings|Landing|index-entry|shared/.test(href))).toBe(false);
  });

  it("omits graph files already referenced by HTML, including single-quoted attributes", async () => {
    const html = `<script src='/assets/index-entry.js' type='module'></script><link href='/assets/shared.js' rel='modulepreload'><link href='/assets/canvas-hashed.js' rel='modulepreload'>`;
    expect(run(await transform("/", graph(), html), "/f/file_a").map((link) => link.href)).toEqual([
      "/assets/Editor-hashed.js", "/assets/math-hashed.js", "/assets/drawer-hashed.js",
    ]);
  });

  it("leaves dev HTML and builds without a separate editor chunk unchanged", async () => {
    expect(await transform("/", null)).toEqual([]);
    const bundle = graph();
    delete bundle["assets/Editor-hashed.js"];
    expect(await transform("/", bundle)).toEqual([]);
  });
});
