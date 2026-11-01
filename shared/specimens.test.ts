import { describe, expect, it } from "vitest";
import { componentName, componentProps, tokenSpecimen } from "./specimens";
import { frameDocument, renderedHtml, tokenNames } from "./types";

describe("component specimens", () => {
  it("keeps family and explicitly named variants rather than inventing states", () => {
    expect(componentName("Button/Primary · Disabled")).toEqual({ family: "Button", variant: "Primary · Disabled" });
    expect(componentName("Navigation/Item/Active")).toEqual({ family: "Navigation", variant: "Item / Active" });
    expect(componentName("Card")).toEqual({ family: "Card", variant: "Default" });
    const html = renderedHtml({ kind: "component", name: "Button/Primary" }, '<button>{{label|Continue}}</button>');
    expect(html).toContain('<x-button-primary></x-button-primary>');
    expect(html).toContain('aria-label="Button / Primary component"');
    expect(html).toContain('label <em>&quot;Continue&quot;</em>');
    expect(html).not.toMatch(/Hover|Focus|Disabled/);
    // The component shows as itself: no card header or badges duplicating the canvas label.
    expect(html).not.toContain('<header');
  });

  it("summarizes actual defaults and slots without inserting sample content into the instance", () => {
    const source = '<section title="{{label|Continue}}">{{label|Proceed}}<slot></slot>{{empty}}</section>';
    expect(componentProps(source)).toEqual([
      { name: "label", defaults: ["Continue", "Proceed"] },
      { name: "empty", defaults: [""] },
    ]);
    const html = renderedHtml({ kind: "component", name: "Card" }, source);
    expect(html).toContain('multiple defaults');
    expect(html).toContain('accepts content');
    expect(html).toContain('<x-card></x-card>');
    expect(html).not.toContain('<x-card>Sample');
  });

  it("keeps board chrome out of a legacy fixed-height component's preview", () => {
    const compact = renderedHtml({ kind: "component", name: "Button/Primary", height: 64 }, "<button>Continue</button>");
    expect(compact).toContain('sp-component--compact');
    expect(compact).toContain('<x-button-primary></x-button-primary>');
    expect(compact).not.toContain('<footer');
    const automatic = renderedHtml({ kind: "component", name: "Button/Primary", height: null }, "<button>Continue</button>");
    expect(automatic).not.toContain('class="sp-component sp-component--fixed');
    expect(automatic).toContain('<footer class="sp-component-spec">');
  });

  it("escapes authored names and defaults in specimen metadata", () => {
    const html = renderedHtml({ kind: "component", name: 'Button/<img src=x onerror="bad()">' }, '<button>{{label|<script>bad()</script>}}</button>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>bad()');
    expect(html).toContain('&lt;img src=x onerror=&quot;bad()&quot;&gt;');
    expect(html).toContain('&lt;script&gt;bad()&lt;/script&gt;');
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
  it("keeps semantic colors first, descriptions escaped, and theme-only tokens out of other panes", () => {
    const html = tokenSpecimen(`@theme {
      --color-z-brand: #123;
      --color-primary: #456; /* Main <action> */
      --color-background: white;
    } [data-theme="brand"] { --color-background: black; --color-night: navy; }`);
    const light = html.split('data-theme="light">')[1]!.split('data-theme="brand"')[0]!;
    const brand = html.split('class="sp-theme" data-theme="brand"')[1]!;
    expect([...light.matchAll(/data-sp-value="([^"]+)"/g)].map((match) => match[1]))
      .toEqual(["color-background", "color-primary", "color-z-brand"]);
    expect(light).toContain('Main &lt;action&gt;');
    expect(light).toContain('bg-background');
    expect(light).toContain('data-sp-value="color-background">white');
    expect(light).not.toContain('data-sp-value="color-night"');
    expect(brand).toContain('data-sp-value="color-background">black');
    expect(brand).toContain('data-sp-value="color-night">navy');
  });

  it("groups declared token types and does not confuse typography metadata with fonts or text sizes", () => {
    const css = '@theme { --color-primary: #566b42; --font-sans: Arial; --font-weight-bold: 700; --text-sm: 14px; --text-sm--line-height: 1.5; --spacing: 4px; --radius-card: 16px; --shadow-soft: 0 4px 12px #0001; }';
    const html = tokenSpecimen(css, 'Fieldnotes foundations');
    for (const section of ["Color", "Typography", "Type scale", "Font weight", "Spacing", "Radius", "Shadow"]) expect(html).toContain(`<h2>${section}<`);
    expect(html).toContain('data-sp-value="color-primary">#566b42');
    expect(html).toContain('font-family:var(--font-sans)');
    expect(html).not.toContain('font-family:var(--font-weight-bold)');
    expect(html).not.toContain('font-size:var(--text-sm--line-height)');
    expect(html).toContain('<h1>Fieldnotes foundations</h1>');
    expect(tokenNames(css)).toHaveLength(8);
  });

  it.each(['.dark { --color-primary: #aabbcc; }', '[data-theme="dark"] { --color-primary: #aabbcc; }', "[data-theme='dark'] { --color-primary: #aabbcc; }"])("renders actual dark overrides with matching class and data-theme context: %s", (dark) => {
    const html = tokenSpecimen(`@theme { --color-primary: #112233; } ${dark}`);
    // Screens are dark, so a sheet with a dark theme shows only that pane, on dark document roots.
    expect(html.startsWith('<html data-theme="dark" class="dark" style="color-scheme:dark"><body data-theme="dark" class="dark">')).toBe(true);
    expect(html).toContain('class="sp-theme dark" data-theme="dark"');
    expect(html).not.toContain('data-theme="light"');
    expect(html).not.toContain('themes</span>');
    expect(html).not.toContain('<p class="sp-theme-title">');
    // Values are read from each pane after CSS resolution, including aliases/overrides.
    expect(html).toContain('getComputedStyle(label).getPropertyValue("--"+name)');
    expect(html).toContain('data-sp-value="color-primary">#aabbcc');
    expect((html.match(/data-sp-value="color-primary"/g) ?? [])).toHaveLength(1);
  });

  it("previews a named theme without treating it as dark or reading commented-out tokens", () => {
    const html = tokenSpecimen('/* .dark { --color-fake: #000; } */ @theme { --color-primary: #112233; } [data-theme="brand"] { --color-primary: #445566; } .dark-mode { --color-primary: #667788; }');
    expect(html).toContain('2 themes');
    expect(html).toContain('class="sp-theme" data-theme="brand"><p class="sp-theme-title">Brand</p>');
    expect(html).not.toContain('class="sp-theme dark"');
    expect(html).not.toContain('data-sp-value="color-fake"');
    expect((html.match(/data-sp-value="color-primary"/g) ?? [])).toHaveLength(2);
  });

  it("previews light and named themes once each in declaration order", () => {
    const html = tokenSpecimen(`
      @theme { --color-primary: #112233; --radius-md: 8px; }
      [data-theme="light"] { --color-primary: #223344; }
      [data-theme = 'UwU'] { --color-primary: #eeaaff; --radius-md: 24px; }
      [data-theme="UwU"] { --radius-md: 32px; }
      @media (min-width: 600px) { [data-theme=high-contrast] { --color-primary: #000; } }
    `);
    expect([...html.matchAll(/class="sp-theme(?: dark)?" data-theme="([^"]+)"/g)].map((m) => m[1]))
      .toEqual(["light", "UwU", "high-contrast"]);
    expect(html).toContain('3 themes');
    expect(html).toContain('<p class="sp-theme-title">UwU</p>');
    expect(html.startsWith("<html")).toBe(false);
    for (const name of ["color-primary", "radius-md"]) expect((html.match(new RegExp(`data-sp-value="${name}"`, "g")) ?? [])).toHaveLength(3);
  });

  it("shows only the dark pane once a dark theme is declared among others", () => {
    const html = tokenSpecimen(`
      @theme { --color-primary: #112233; --radius-md: 8px; }
      [data-theme="light"] { --color-primary: #223344; }
      [data-theme = 'UwU'] { --color-primary: #eeaaff; --radius-md: 24px; }
      .dark, [data-theme=dark] { --color-primary: #aabbcc; }
      [data-theme="UwU"] { --radius-md: 32px; }
      @media (min-width: 600px) { [data-theme=high-contrast] { --color-primary: #000; } }
    `);
    expect([...html.matchAll(/class="sp-theme(?: dark)?" data-theme="([^"]+)"/g)].map((m) => m[1])).toEqual(["dark"]);
    expect(html).not.toContain('themes</span>');
    for (const name of ["color-primary", "radius-md"]) expect((html.match(new RegExp(`data-sp-value="${name}"`, "g")) ?? [])).toHaveLength(1);
  });

  it("does not create theme panes from comments, CSS strings, empty values or lookalike selectors", () => {
    const html = tokenSpecimen(`
      /* [data-theme="comment"] { --color-primary: red; } */
      @theme { --color-primary: #112233; --font-sans: ".dark [data-theme='quoted']"; }
      .label::after { content: '[data-theme="content"] .dark'; }
      [data-theme=""], [data-theme-mode="dark"], .dark-mode { --color-primary: #445566; }
    `);
    expect(html).not.toContain('themes</span>');
    expect(html).not.toContain('class="sp-theme dark"');
    expect((html.match(/data-sp-value="color-primary"/g) ?? [])).toHaveLength(1);
  });

  it("escapes labels and CSS declaration values and provides an honest empty state", () => {
    const html = tokenSpecimen('@theme { --font-sans: "<img src=x>"; }', '<script>name</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>name');
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    const themed = tokenSpecimen('@theme { --color-primary: #112233; } [data-theme=\'UwU"><img src=x>\'] { --color-primary: #445566; }');
    expect(themed).toContain('data-theme="UwU&quot;&gt;&lt;img src=x&gt;"');
    expect(themed).toContain('<p class="sp-theme-title">UwU&quot;&gt;&lt;img src=x&gt;</p>');
    expect(themed).not.toContain('<img');
    const empty = tokenSpecimen('/* --color-fake: red; */');
    expect(empty).toContain('0 tokens');
    expect(empty).toContain('Give this system its first decisions.');
  });
});
