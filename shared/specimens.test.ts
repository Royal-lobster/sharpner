import { describe, expect, it } from "vitest";
import { componentName, tokenSpecimen } from "./specimens";
import { frameDocument, renderedHtml, tokenNames } from "./types";

describe("component specimens", () => {
  it("keeps family and explicitly named variants rather than inventing states", () => {
    expect(componentName("Button/Primary · Disabled")).toEqual({ family: "Button", variant: "Primary · Disabled" });
    expect(componentName("Navigation/Item/Active")).toEqual({ family: "Navigation", variant: "Item / Active" });
    expect(componentName("Card")).toEqual({ family: "Card", variant: "Default" });
    const html = renderedHtml({ kind: "component", name: "Button/Primary" }, '<button>{{label|Continue}}</button>');
    expect(html).toContain('<x-button-primary></x-button-primary>');
    expect(html).toContain('aria-label="Button / Primary component"');
    expect(html).not.toMatch(/Hover|Focus|Disabled/);
    // The component shows as itself: no card header, caption or badges. The canvas marks it as a component.
    expect(html).not.toMatch(/<header|<footer|Continue|sp-component-spec/);
  });

  it("shows the default instance without inserting sample content, at a fixed height when one is set", () => {
    const html = renderedHtml({ kind: "component", name: "Card" }, '<section>{{label|Proceed}}<slot></slot></section>');
    expect(html).toContain('<x-card></x-card>');
    expect(html).toContain('class="sp-component"');
    const fixed = renderedHtml({ kind: "component", name: "Button/Primary", height: 64 }, "<button>Continue</button>");
    expect(fixed).toContain('class="sp-component sp-component--fixed"');
    expect(fixed).toContain('<x-button-primary></x-button-primary>');
  });

  it("lays the default instance out at the node's full width, as a frame of that width does", () => {
    const html = renderedHtml({ kind: "component", name: "Trade/Position" }, '<section class="w-full">{{label|Sell}}</section>');
    const rule = (selector: string) => html.match(new RegExp(`${selector.replace(/[.>*]/g, "\\$&")}\\{([^}]*)\\}`))?.[1] ?? "";
    // No side padding: a 390px component gets 390px, so it wraps, truncates and overflows only where it would in use.
    expect(rule(".sp-component-stage")).toContain("padding:12px 0");
    expect(rule(".sp-component-stage")).toContain("grid-template-columns:minmax(0,1fr)");
    // Normal flow, not a centring grid: block roots fill the width instead of shrinking to fit or being cut off at the
    // left. Only inline-level roots are centred, and the instance's own text starts from the start.
    expect(rule(".sp-component-instance")).toMatch(/display:flow-root;.*width:100%;text-align:center/);
    expect(rule(".sp-component-instance>*")).toBe("text-align:start");
    expect(html).not.toMatch(/place-items|justify-items|fit-content/);
  });

  it("escapes authored names in the specimen", () => {
    const html = renderedHtml({ kind: "component", name: 'Button/<img src=x onerror="bad()">' }, '<button>Go</button>');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt;');
  });

  it("presents components in dark when the design system defines a dark theme", () => {
    const light = renderedHtml({ kind: "component", name: "Button" }, "<button>Go</button>", { tokens: "@theme { --color-background: white; }" });
    expect(light.startsWith("<style>")).toBe(true);
    expect(light).not.toContain('data-theme="dark"');
    for (const tokens of [".dark { --color-background: black; }", '[data-theme="dark"] { --color-background: black; }']) {
      const dark = renderedHtml({ kind: "component", name: "Button" }, "<button>Go</button>", { tokens: `@theme { --color-background: white; } ${tokens}` });
      expect(dark.startsWith('<html data-theme="dark" class="dark" style="color-scheme:dark"><body data-theme="dark" class="dark"><style>')).toBe(true);
      expect(dark).toContain("<x-button></x-button>");
      // A full document still receives the design system's head and component definitions, and a doctype:
      // without one the thumbnail renderer lays it out in quirks mode, where <body> fills the viewport and
      // every specimen measures as tall as the page.
      expect(frameDocument(dark, { design: { tokens, components: [] } })).toMatch(/^<!doctype html><html data-theme="dark"[^>]*><head>/);
    }
  });

  it("renders full documents in standards mode, as live srcdoc previews do", () => {
    expect(frameDocument("<html><body><p>Hi</p></body></html>")).toMatch(/^<!doctype html><html><head>/);
    expect(frameDocument("  <HTML lang=\"en\"><p>Hi</p></HTML>")).toMatch(/^<!doctype html>\s*<HTML lang="en"><head>/);
    const authored = frameDocument("<!DOCTYPE html><html><body><p>Hi</p></body></html>");
    expect(authored.match(/<!doctype/gi)).toHaveLength(1);
    expect(authored.startsWith("<!DOCTYPE html><html><head>")).toBe(true);
  });

  it("changes the node presentation while leaving screens and component definitions intact", () => {
    const source = '<main><x-button-primary label="Save"></x-button-primary></main>';
    expect(renderedHtml({ kind: "frame", name: "Screen" }, source)).toBe(source);
    const component = '<button>{{label|Continue}}</button>';
    const screen = frameDocument(source, { design: { tokens: "", components: [{ tag: "x-button-primary", html: component }] } });
    expect(screen).not.toContain('sp-component-spec');
    expect(screen).toContain(JSON.stringify(component).replace(/</g, "\\u003c"));
  });
});

describe("foundation specimens", () => {
  const values = (html: string, name: string) => [...html.matchAll(new RegExp(`data-sp-value="${name}">([^<]*)<`, "g"))].map((m) => m[1]);

  it("shows every distinct theme inside each swatch, Dark first, instead of a pane per theme", () => {
    const html = tokenSpecimen(`:root { --color-background: #fff; --color-primary: #112233; --radius-md: 8px; }
      .dark { --color-background: #000; --color-primary: #aabbcc; } [data-theme="brand"] { --color-primary: #112233; }
      [data-theme="uwu"] { --color-primary: #eeaaff; }`);
    // The document roots stay unthemed; the sheet's chrome takes the first column's theme.
    expect(html.startsWith("<style>")).toBe(true);
    expect(html).toContain('<article class="sp-foundations sp-t0 dark" data-theme="dark" style="color-scheme:dark">');
    expect([...html.matchAll(/<span class="sp-chip">.*?<\/span>([^<]+)<\/span>/g)].map((m) => m[1])).toEqual(["Dark", "Light · Brand", "Uwu"]);
    expect(html).toContain("3 themes");
    expect(values(html, "color-primary")).toEqual(["#aabbcc", "#112233", "#eeaaff"]);
    const swatch = html.split("<code>primary")[0]!.split('<div class="sp-swatch">').at(-1)!;
    expect([...swatch.matchAll(/class="sp-half (sp-t\d)[^"]*"/g)].map((m) => m[1])).toEqual(["sp-t0", "sp-t1", "sp-t2"]);
    // Radius is one token, shown once.
    expect(html.match(/data-sp-length style="column-gap:var\(--radius-md\)"/g)).toHaveLength(1);
  });

  it("redeclares each column's tokens so var() chains resolve in it, and leaves another theme's tokens undefined", () => {
    const html = tokenSpecimen(`:root { --surface: white; } .dark { --surface: black; --night: navy; }
      @theme inline { --color-card: var(--surface); } .dark { --color-night: var(--night); }`);
    const rule = (i: number) => html.match(new RegExp(`\\.sp-foundations \\.sp-t${i},\\.sp-foundations\\.sp-t${i}\\{([^}]*)\\}`))![1]!;
    for (const declaration of ["--surface:black", "--color-card:var(--surface)", "--color-night:var(--night)"]) expect(rule(0)).toContain(declaration);
    for (const declaration of ["--surface:white", "--color-card:var(--surface)"]) expect(rule(1)).toContain(declaration);
    expect(rule(1)).toContain("--color-night:initial");
    expect(values(html, "color-night")).toEqual(["var(--night)", "—"]);
  });

  it("shows a dark-rooted sheet with a light alternative as Dark and Light", () => {
    const html = tokenSpecimen(`:root, [data-theme="tupredices"] { --background: #1a1d20; } .light, [data-theme="tupredices-light"] { --background: #fff; }
      :root, .light, [data-theme] { --color-background: var(--background); }`);
    expect(html).toContain('<article class="sp-foundations sp-t0" style="color-scheme:dark">');
    expect(html).toContain('class="sp-half sp-t1 light" data-theme="light" style="color-scheme:light"');
    expect(html).toContain("Dark · Tupredices</span>");
    expect(html).toContain("Light · Tupredices-light</span>");
  });

  it("lists shadcn's slots first, flags undeclared ones, and pairs foregrounds with a contrast reading", () => {
    const html = tokenSpecimen(`@theme { --color-card: #222; --color-card-foreground: #eee; --color-primary: #d4ff00; /* Main <action> */
      --color-yes: #93d17b; --color-yes-foreground: #111; --color-panel: #222; --color-chart-1: red; }`);
    const colour = html.split("Product additions")[0]!;
    expect(colour).toContain("<code>card <i>/ foreground</i></code>");
    expect(colour).toContain('<span class="sp-aa" style="color:var(--color-card-foreground)">Aa</span><span class="sp-cr" data-sp-contrast></span>');
    // A declared slot whose foreground is missing says so, and has no contrast reading.
    expect(colour).toContain('<span class="sp-same">primary-foreground not declared</span>');
    expect(colour.split("<code>primary")[0]!.split("sp-swatch").at(-1)).not.toContain("data-sp-contrast");
    expect(colour).toContain('Main &lt;action&gt;');
    expect(colour).toContain('<div class="sp-swatch sp-missing"><div class="sp-chips">not declared</div><code>background</code></div>');
    expect(colour).toContain("shadcn · chart<span class=\"sp-n\">1 of 5</span>");
    expect(colour).toContain("shadcn · sidebar: none of its 8 slots is declared (sidebar, sidebar-foreground, sidebar-primary, sidebar-primary-foreground, sidebar-accent, sidebar-accent-foreground, sidebar-border, sidebar-ring).");
    expect(html).toContain("4 of 32 shadcn slots · 3 additions");
    const additions = html.split("Product additions")[1]!;
    expect(additions).toContain("<code>yes <i>/ foreground</i></code>");
    expect(additions).not.toContain("<code>yes-foreground");
    expect(additions).toContain('<span class="sp-same">same as card</span>');
    // Contrast is measured in the browser, from the painted colours.
    expect(html).toContain("getImageData(0,0,1,1)");
  });

  it("draws palette ramps per theme and the type scale with its line heights", () => {
    const html = tokenSpecimen(`:root { --lime-1: #111; --lime-2: #222; --lime-3: #333; --lime-4: #444; --lime-5: #555; }
      .dark { --lime-1: #eee; } @theme { --font-sans: Figtree; --font-display: Sora; /* Headlines */
      --text-sm: 13px; --text-sm--line-height: 18px; --text-5xl: 48px; --text-icon: 16px; --font-weight-bold: 700; --tracking-tight: -0.02em; }`);
    expect(html).toContain("<h2>Palette ramps");
    expect(html.match(/<span style="background:var\(--lime-1\)"/g)).toHaveLength(2);
    expect(html).toContain('<b>Dark</b>');
    expect(html).toContain('font-family:var(--font-display)">Ag');
    expect(html).toContain('<span class="sp-desc">Headlines</span>');
    expect(html).toContain('<span data-sp-value="text-sm">13px</span> / <span data-sp-value="text-sm--line-height">18px</span>');
    expect(html).toContain('font-size:var(--text-5xl);font-family:var(--font-display)');
    expect(html).toContain('font-size:var(--text-sm);line-height:var(--text-sm--line-height);font-family:var(--font-sans,inherit)');
    expect(html.indexOf("<code>text-5xl")).toBeLessThan(html.indexOf("<code>text-sm"));
    expect(html).toContain('Icon sizes: <code>text-icon</code> <span data-sp-value="text-icon">16px</span>');
    expect(html).toContain('style="font-weight:var(--font-weight-bold)"');
    expect(html).toContain('style="letter-spacing:var(--tracking-tight)"');
    expect(html).not.toContain('font-family:var(--font-weight-bold)');
  });

  it("draws spacing as a scale, notes Tailwind's default when --spacing is missing, and resolves radii in the browser", () => {
    const declared = tokenSpecimen("@theme { --spacing: 0.25rem; --radius: 0.625rem; --radius-sm: calc(var(--radius) - 4px); }");
    expect(declared.match(/class="sp-space-row"/g)).toHaveLength(8);
    expect(declared).toContain('style="width:calc(var(--spacing) * 12)"');
    expect(declared).toContain('data-sp-length style="column-gap:calc(var(--spacing) * 12)">48px<');
    expect(declared).toContain('data-sp-length style="column-gap:var(--radius-sm)">calc(var(--radius) - 4px)<');
    expect(declared).toContain('getComputedStyle(label).columnGap');
    const missing = tokenSpecimen("@theme { --color-primary: red; --font-sans: Inter; }");
    expect(missing).toContain("No <code>--spacing</code> is declared, so Tailwind's 0.25rem default applies.");
    expect(missing).toContain("so Tailwind's default type scale applies");
  });

  it("shows shadows in each theme and motion as bars, curves and a list", () => {
    const html = tokenSpecimen(`:root { --shadow-popover: 0 8px 24px #0003; } .dark { --shadow-popover: 0 8px 24px #0008; }
      @theme { --duration-fast: 120ms; --duration-slow: 0.3s; --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --ease-snap: ease-in; --animate-pop: pop-in 200ms ease-out; }`);
    expect(html.match(/<div style="box-shadow:var\(--shadow-popover\)">/g)).toHaveLength(2);
    expect(values(html, "shadow-popover")).toEqual(["0 8px 24px #0008", "0 8px 24px #0003"]);
    expect(html).toContain('<span style="width:40%"></span>');
    expect(html).toContain('<span style="width:100%"></span>');
    expect(html).toContain('<path d="M6.0,106.0 C29.0,6.0 38.0,6.0 106.0,6.0"');
    expect(html.match(/<path d=/g)).toHaveLength(2);
    expect(html).toContain('<code>animate-pop</code><span class="sp-value" data-sp-value="animate-pop">pop-in 200ms ease-out</span>');
  });

  it("does not create themes from comments, CSS strings, empty values or lookalike selectors", () => {
    const html = tokenSpecimen(`
      /* [data-theme="comment"] { --color-primary: red; } */
      @theme { --color-primary: #112233; --font-sans: ".dark [data-theme='quoted']"; }
      .label::after { content: '[data-theme="content"] .dark'; }
      [data-theme=""], [data-theme-mode="dark"], .dark-mode { --color-primary: #445566; }
    `);
    expect(html).not.toContain("themes</p>");
    expect(html).not.toContain('class="sp-legend"');
    expect(values(html, "color-primary")).toEqual(["#112233"]);
    expect(html).toContain('getComputedStyle(label).getPropertyValue("--"+name)');
  });

  it("escapes labels, theme names and values, and keeps an honest empty state", () => {
    const html = tokenSpecimen('@theme { --font-sans: "<img src=x>"; }', '<script>name</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>name');
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    // A value that could close the style element is never redeclared.
    expect(html).toContain("--font-sans:initial");
    const themed = tokenSpecimen('@theme { --color-primary: #112233; } [data-theme=\'UwU"><img src=x>\'] { --color-primary: #445566; }');
    expect(themed).toContain('data-theme="UwU&quot;&gt;&lt;img src=x&gt;"');
    expect(themed).toContain('UwU&quot;&gt;&lt;img src=x&gt;</span>');
    expect(themed).not.toContain('<img');
    const empty = tokenSpecimen('/* --color-fake: red; */');
    expect(empty).toContain('0 tokens');
    expect(empty).toContain('Give this system its first decisions.');
    expect(empty).not.toContain("<h2>");
  });

  it("counts tokens and keeps typography metadata out of fonts and sizes", () => {
    const css = '@theme { --color-primary: #566b42; --font-sans: Arial; --font-weight-bold: 700; --text-sm: 14px; --text-sm--line-height: 1.5; --spacing: 4px; --radius-card: 16px; --shadow-soft: 0 4px 12px #0001; }';
    const html = tokenSpecimen(css, 'Fieldnotes foundations');
    for (const section of ["Colour", "Typography", "Spacing", "Radius", "Shadow"]) expect(html).toMatch(new RegExp(`>${section}<`));
    expect(html).toContain('<h1>Fieldnotes foundations</h1>');
    expect(html).toContain('8 tokens');
    expect(html).not.toContain('font-size:var(--text-sm--line-height)');
    expect(tokenNames(css)).toHaveLength(8);
  });
});
