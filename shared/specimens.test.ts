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
    expect(html).toContain('class="sp-theme dark" data-theme="dark"');
    expect(html).toContain('2 themes');
    // Values are read from each pane after CSS resolution, including aliases/overrides.
    expect(html).toContain('getComputedStyle(label).getPropertyValue("--"+name)');
    expect((html.match(/data-sp-value="color-primary"/g) ?? [])).toHaveLength(2);
  });

  it("does not invent a dark theme from a comment or an unrelated named theme", () => {
    const html = tokenSpecimen('/* .dark { --color-fake: #000; } */ @theme { --color-primary: #112233; } [data-theme="brand"] { --color-primary: #445566; } .dark-mode { --color-primary: #667788; }');
    expect(html).not.toContain('2 themes');
    expect(html).not.toContain('class="sp-theme dark"');
    expect(html).not.toContain('data-sp-value="color-fake"');
    expect((html.match(/data-sp-value="color-primary"/g) ?? [])).toHaveLength(1);
  });

  it("escapes labels and CSS declaration values and provides an honest empty state", () => {
    const html = tokenSpecimen('@theme { --font-sans: "<img src=x>"; }', '<script>name</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>name');
    expect(html).toContain('&lt;script&gt;name&lt;/script&gt;');
    expect(html).toContain('&lt;img src=x&gt;');
    const empty = tokenSpecimen('/* --color-fake: red; */');
    expect(empty).toContain('0 tokens');
    expect(empty).toContain('Give this system its first decisions.');
  });
});
