import { describe, expect, it } from "vitest";
import { componentTheme, effectiveTheme, themeNames, themeSwatches, validateTheme } from "./themes";
import { frameDocument, renderedHtml } from "./types";

describe("theme selection", () => {
  it("discovers unique CSS theme contexts in order, including legacy dark, without reading comments or strings", () => {
    expect(themeNames(`
      /* [data-theme=unused] {} */
      @theme { --font-sans: '.dark [data-theme="quoted"]'; }
      [data-theme=UwU] {} .dark {} [data-theme="UwU"] {}
      .dark-mode {} [data-theme-mode=invalid] {} [data-theme='high contrast'] {}
    `)).toEqual(["light", "UwU", "dark", "high contrast"]);
  });

  it("previews any named theme from its own token values, layered over the defaults", () => {
    const swatches = themeSwatches(`
      @theme { --color-background: #fff; --color-primary: oklch(0.6 0.2 260); --font-sans: Inter; }
      /* [data-theme="ghost"] { --color-background: red; } */
      @layer base { .dark { --color-background: #111; } }
      [data-theme="uwu"], [data-theme='candy'] { --color-surface: pink; --color-brand: var(--color-primary); }
      [data-theme=mono] { --radius-card: 0; }
    `);
    expect([...swatches.keys()]).toEqual(["light", "dark", "uwu", "candy"]);
    expect(swatches.get("light")).toMatchObject({ background: "var(--color-background)", accent: "var(--color-primary)" });
    expect(swatches.get("dark")!.vars).toMatchObject({ "--color-background": "#111", "--color-primary": "oklch(0.6 0.2 260)" });
    // A theme's own tokens win over inherited ones, even under other names; references still resolve.
    expect(swatches.get("uwu")).toMatchObject({ background: "var(--color-surface)", accent: "var(--color-brand)" });
    expect(swatches.get("uwu")!.vars).toMatchObject({ "--color-surface": "pink", "--color-primary": "oklch(0.6 0.2 260)" });
    expect(swatches.get("dark")).toMatchObject({ background: "var(--color-background)", accent: "var(--color-primary)" });
    expect(themeSwatches("").get("light")).toEqual({ vars: {}, background: undefined, accent: undefined });
  });

  it("resolves the theme a component instance renders in, as the document theme script will leave it", () => {
    // Minimal element tree: just what componentTheme reads.
    const doc = {} as { body: FakeElement; documentElement: FakeElement };
    class FakeElement {
      readonly classList = { contains: (c: string) => this.classes.includes(c) };
      constructor(readonly parentElement: FakeElement | null, readonly attrs: Record<string, string> = {}, readonly classes: string[] = []) {}
      get ownerDocument() { return doc; }
      getAttribute(k: string) { return this.attrs[k] ?? null; }
      closest(_selector: string) {
        for (let n: FakeElement | null = this; n; n = n.parentElement) if (n.attrs["data-theme"] !== undefined || n.classes.includes("dark") || n.classes.includes("light")) return n;
        return null;
      }
    }
    const make = (parent: FakeElement | null, attrs?: Record<string, string>, classes?: string[]) => new FakeElement(parent, attrs, classes);
    const html = make(null), body = make(html);
    doc.documentElement = html; doc.body = body;
    const at = (parent: FakeElement) => make(parent) as unknown as Element;
    const dark = make(body, {}, ["dark"]), nestedLight = make(dark, {}, ["light"]), sakura = make(body, { "data-theme": "sakura" });

    expect(componentTheme(at(body), "uwu")).toBe("uwu");
    expect(componentTheme(at(dark), "uwu")).toBe("uwu");
    expect(componentTheme(at(nestedLight), "uwu")).toBe("light");
    expect(componentTheme(at(sakura), null)).toBe("sakura");
    expect(componentTheme(at(dark), undefined)).toBe("dark");
    expect(componentTheme(at(body), null)).toBe("");
  });

  it("ships every definition of a component to the document, grouped by theme", () => {
    const html = frameDocument("<x-button></x-button>", { theme: "sakura", design: { tokens: "", components: [
      { tag: "x-button", html: "<button>Plain</button>" },
      { tag: "x-button", html: "<button>Petals</button>", theme: "sakura" },
    ] } });
    expect(html).toContain('"x-button":{"":"\\u003cbutton>Plain\\u003c/button>","sakura":"\\u003cbutton>Petals\\u003c/button>"}');
    expect(html).toContain("function componentTheme(");
    expect(html).toContain("__sharpnerTheme = theme");
    // The theme announcement must run before parsing ends, when components expand.
    expect(html.indexOf(')("sakura")</script>')).toBeGreaterThan(html.indexOf("customElements.define"));
  });

  it("renders a component override's specimen in its own theme, whatever the file uses", () => {
    expect(effectiveTheme({ kind: "component", theme: "sakura" }, "dark")).toBe("sakura");
    expect(effectiveTheme({ kind: "component", theme: null }, "dark")).toBe("dark");
    const override = renderedHtml({ kind: "component", name: "Button/Primary", theme: "sakura" }, "<button>Go</button>");
    expect(override).toContain("theme <em>Sakura</em>");
    // Each specimen shows its own definition, so the default stays visible while the file uses an overriding theme.
    expect(override).toContain('<x-button-primary data-sharpner-definition="sakura">');
    expect(renderedHtml({ kind: "component", name: "Button/Primary" }, "<button>Go</button>")).toContain('<x-button-primary data-sharpner-definition="">');
  });

  it("inherits file themes while retaining screen overrides and foundation comparisons", () => {
    expect(effectiveTheme({ kind: "frame" }, "dark")).toBe("dark");
    expect(effectiveTheme({ kind: "frame", theme: null }, "UwU")).toBe("UwU");
    expect(effectiveTheme({ kind: "frame", theme: "light" }, "dark")).toBe("light");
    expect(effectiveTheme({ kind: "component" }, "dark")).toBe("dark");
    for (const kind of ["tokens", "image", "section"]) expect(effectiveTheme({ kind }, "dark")).toBeUndefined();
    expect(effectiveTheme({ kind: "frame" }, null)).toBeUndefined();
  });

  it("preserves legacy authored appearance until a theme is selected", () => {
    const source = '<main data-theme="dark" class="dark">Screen</main>';
    const original = frameDocument(source);
    expect(frameDocument(source, { theme: null })).toBe(original);
    expect(original).toContain(source);
    const themed = frameDocument(source, { theme: "light" });
    expect(themed).toContain(source);
    expect(themed).toContain(')("light")</script></body>');
    const full = frameDocument(`<!doctype html><html><head></head><body>${source}</body></html>`, { theme: "dark" });
    expect(full).toContain(')("dark")</script></body></html>');
  });

  it("keeps theme names from terminating the generated runtime script", () => {
    const html = frameDocument("<main>Screen</main>", { theme: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it.each(["", " ", "x".repeat(81), "dark\n", 12, undefined, {}, ["dark"]])("rejects malformed persisted themes: %j", (value) => {
    expect(() => validateTheme(value)).toThrow(/Theme must/);
  });
});

describe("prepared thumbnail fonts", () => {
  it("emits embedded font faces as plain CSS, outside the Tailwind source", () => {
    const html = frameDocument("<p>Hi</p>", { compiledTailwind: true, fontCss: "@font-face{font-family:Inter;src:url(data:font/woff2;base64,AQID)}", design: { tokens: "@theme { --font-sans: Inter; }", components: [] } });
    expect(html).toContain('<style data-sharpner-fonts>@font-face{font-family:Inter;src:url(data:font/woff2;base64,AQID)}</style>');
    expect(html).toMatch(/<style type="text\/tailwindcss">@theme static \{ --font-sans: Inter; \}<\/style>/);
    expect(html).not.toContain("<link");
  });
});
