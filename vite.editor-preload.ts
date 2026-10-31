import type { Plugin } from "vite";

/** Start direct-file editor downloads during HTML parsing, alongside the normal app entry. */
export function editorPreload(): Plugin {
  let base = "/";
  return {
    name: "sharpner-editor-preload",
    apply: "build",
    configResolved(config) { base = config.base; },
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle }) {
        if (!bundle) return [];
        const editor = Object.values(bundle).find((item) => item.type === "chunk" && item.facadeModuleId?.replace(/\\/g, "/").endsWith("/src/Editor.tsx"));
        if (!editor) return [];
        const existing = new Set([...html.matchAll(/\b(?:src|href)\s*=\s*(["'])(.*?)\1/g)].map((match) => match[2]));
        const visited = new Set<string>();
        const urls: string[] = [];
        const visit = (name: string) => {
          if (visited.has(name)) return;
          visited.add(name);
          const chunk = bundle[name];
          if (!chunk || chunk.type !== "chunk") return;
          const url = `${base}${chunk.fileName}`;
          if (!existing.has(url)) urls.push(url);
          for (const dependency of chunk.imports) visit(dependency);
        };
        visit(editor.fileName);
        if (!urls.length) return [];
        // Keep this after the existing auth bootstrap so that sign-in configuration retains its priority.
        return [{
          tag: "script",
          injectTo: "head",
          children: String.raw`if (/^\/(?:f\/[\w-]+|s\/[A-Za-z0-9_-]{43})\/?$/.test(location.pathname)) {
  for (const href of ${JSON.stringify(urls).replace(/</g, "\\u003c")}) {
    const link = document.createElement("link");
    link.rel = "modulepreload"; link.crossOrigin = "anonymous"; link.href = href;
    document.head.append(link);
  }
}`,
        }];
      },
    },
  };
}
