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
        const script = String.raw`if (/^\/(?:f\/[\w-]+|s\/[A-Za-z0-9_-]{43})\/?$/.test(location.pathname)) {
  for (const href of ${JSON.stringify(urls).replace(/</g, "\\u003c")}) {
    const link = document.createElement("link");
    link.rel = "modulepreload"; link.crossOrigin = "anonymous"; link.href = href;
    document.head.append(link);
  }
}`;
        // A classic script after Vite's stylesheet waits for that stylesheet before executing.
        // Insert before it, keeping the earlier auth bootstrap first. Skip tag-like text in scripts,
        // styles and comments; fall back to the end of the head when the build emits no stylesheet.
        const headEnd = html.search(/<\/head\s*>/i);
        const head = headEnd < 0 ? html : html.slice(0, headEnd);
        const stylesheet = [...head.matchAll(/<!--[\s\S]*?-->|<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>|<link\b[^>]*>/gi)]
          .find(([tag]) => /^<link\b/i.test(tag) && /\srel\s*=\s*(?:"[^"]*\bstylesheet\b[^"]*"|'[^']*\bstylesheet\b[^']*'|stylesheet(?=\s|>))/i.test(tag));
        const at = stylesheet?.index ?? (headEnd < 0 ? html.length : headEnd);
        return `${html.slice(0, at)}<script>${script}</script>\n${html.slice(at)}`;
      },
    },
  };
}
