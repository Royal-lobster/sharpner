import { runInNewContext } from "node:vm";
import { build, type HtmlTagDescriptor, type IndexHtmlTransformContext, type IndexHtmlTransformHook, type Plugin, type ResolvedConfig } from "vite";
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
  return await hook.handler.call({} as never, html, { path: "/index.html", filename: "/app/index.html", bundle: bundle ?? undefined }) as string | HtmlTagDescriptor[];
}

function run(output: string | HtmlTagDescriptor[], pathname: string) {
  const append = vi.fn();
  const scripts = typeof output === "string"
    ? [...output.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map((match) => match[1]!)
    : output.map((tag) => tag.children as string);
  for (const script of scripts) {
    runInNewContext(script, {
      location: { pathname },
      document: { createElement: () => ({}), head: { append } },
    });
  }
  return append.mock.calls.map(([link]) => link as { href: string; rel: string; crossOrigin: string });
}

describe("early direct-file editor module preloads", () => {
  it("emits the preload script after auth bootstrap and before the build's blocking stylesheet", async () => {
    const root = "/sharpner-editor-preload-fixture";
    const files: Record<string, string> = {
      [`${root}/index.html`]: `<!doctype html><html><head>
        <script>window.__sharpnerAuthConfig = fetch("/auth/config");</script>
        <script type="module" src="/src/main.ts"></script>
        </head><body><div id="root"></div></body></html>`,
      [`${root}/src/main.ts`]: `import "./style.css"; import("./Editor.tsx").then((module) => { window.editor = module.Editor; });`,
      [`${root}/src/Editor.tsx`]: `export const Editor = "editor";`,
      [`${root}/src/style.css`]: `.canvas { color: white; }`,
    };
    const fixture: Plugin = {
      name: "editor-preload-virtual-build-fixture",
      resolveId(source, importer) {
        const id = source.startsWith("/src/") ? `${root}${source}`
          : source.startsWith("./") && importer ? `${importer.slice(0, importer.lastIndexOf("/"))}/${source.slice(2)}` : source;
        return id in files ? id : undefined;
      },
      load(id) { return files[id]; },
    };
    const result = await build({
      configFile: false, root, publicDir: false, logLevel: "silent", plugins: [fixture, editorPreload()],
      build: { write: false, minify: false, rolldownOptions: { input: `${root}/index.html` } },
    });
    const output = Array.isArray(result) ? result[0]! : result;
    if (!("output" in output)) throw new Error("Expected an in-memory production build");
    const asset = output.output.find((item) => item.type === "asset" && item.fileName === "index.html");
    if (!asset || asset.type !== "asset") throw new Error("Production build did not emit index.html");
    const html = String(asset.source);
    const authEnd = html.indexOf("</script>", html.indexOf("window.__sharpnerAuthConfig")) + "</script>".length;
    const preloadStart = html.lastIndexOf("<script", html.indexOf('document.createElement("link")'));
    const stylesheetStart = html.search(/<link\b[^>]*\brel="stylesheet"/i);
    expect(authEnd).toBeGreaterThan("</script>".length);
    expect(stylesheetStart).toBeGreaterThan(authEnd);
    expect(preloadStart).toBeGreaterThan(authEnd);
    expect(preloadStart).toBeLessThan(stylesheetStart);
  });

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

  it("ignores stylesheet-looking text and inserts before a real stylesheet with reordered attributes", async () => {
    const html = `<html><head>
      <script>window.example = '<link rel="stylesheet" href="example.css">';</script>
      <!-- <link rel="stylesheet" href="comment.css"> -->
      <link href='/assets/app.css' crossorigin rel='stylesheet'>
      </head><body></body></html>`;
    const output = await transform("/", graph(), html);
    expect(typeof output).toBe("string");
    const result = output as string;
    expect(result.indexOf('document.createElement("link")')).toBeGreaterThan(result.indexOf("comment.css"));
    expect(result.indexOf('document.createElement("link")')).toBeLessThan(result.indexOf("<link href='/assets/app.css'"));
  });

  it("keeps the preload in the head after bootstrap when no stylesheet is emitted", async () => {
    const html = `<html><head><script>window.__sharpnerAuthConfig = Promise.resolve({});</script></head><body></body></html>`;
    const output = await transform("/", graph(), html);
    const result = output as string;
    expect(result.indexOf('document.createElement("link")')).toBeGreaterThan(result.indexOf("window.__sharpnerAuthConfig"));
    expect(result.indexOf('document.createElement("link")')).toBeLessThan(result.indexOf("</head>"));
  });

  it("leaves dev HTML and builds without a separate editor chunk unchanged", async () => {
    expect(await transform("/", null)).toEqual([]);
    const bundle = graph();
    delete bundle["assets/Editor-hashed.js"];
    expect(await transform("/", bundle)).toEqual([]);
  });
});
