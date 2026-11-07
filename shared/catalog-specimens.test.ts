import { describe, expect, it } from "vitest";
import { catalogSpecimen, CELL_PAD_X, familySpecimens, parseExamples, propAxes, specimenThemes, specimenWidth } from "./catalog-specimens";
import { frameDocument, renderedHtml } from "./types";

const button = (size = "{{size|md|sm,md,lg}}") => `<button data-size="${size}">{{label|Send}}</button>`;

describe("prop axes", () => {
  it("reads a prop's listed values, adding a missing default first", () => {
    expect(propAxes(button())).toEqual([{ name: "size", def: "md", values: ["sm", "md", "lg"] }]);
    expect(propAxes(`{{tone|neutral|success, danger}}`)).toEqual([{ name: "tone", def: "neutral", values: ["neutral", "success", "danger"] }]);
  });

  it("ignores props without a list, or with a list of one", () => {
    expect(propAxes(`{{label|Send}} {{size|md|md}}`)).toEqual([]);
  });

  it("renders an instance with the default, not the list", () => {
    // The custom element script must stop the default at the second pipe.
    const doc = frameDocument("<x-b></x-b>", { design: { tokens: "", components: [{ tag: "x-b", html: button() }] } });
    const pattern = /this\.innerHTML=h\.replace\((\/.*?\/g),/.exec(doc)![1]!;
    const regex = new Function(`return ${pattern}`)() as RegExp;
    expect(button().replace(regex, (_, _k, v) => (v || "").trim())).toBe('<button data-size="md">Send</button>');
  });
});

describe("compared themes", () => {
  it("compares Dark and Light when the tokens declare dark, light rendering as authored", () => {
    expect(specimenThemes(`[data-theme="dark"] { --color-background: #000 }`).map((t) => t.name)).toEqual(["dark", "light"]);
    expect(specimenThemes(`.dark { --x: 1 }`)[0]!.attrs).toContain('data-theme="dark"');
  });

  it("treats a declared light theme as the alternative to a dark default", () => {
    const themes = specimenThemes(`:root { --bg: #111 } .light, [data-theme="light"] { --bg: #fff }`);
    expect(themes.map((t) => t.name)).toEqual(["dark", "light"]);
    expect(themes[0]!.attrs).not.toContain("data-theme");
    expect(themes[1]!.attrs).toContain('class="light"');
  });

  it("shows only the default when neither is declared, and ignores decorative themes and comments", () => {
    expect(specimenThemes(`/* .dark */ [data-theme="uwu"] { --x: 1 }`)).toEqual([{ name: "", attrs: "" }]);
  });
});

describe("family specimens", () => {
  const dark = specimenThemes(`.dark{}`), plain = specimenThemes("");
  const member = (id: string, source: string, width = 120) => ({ id, name: `Button/${id}`, width, source });

  it("shares one column list and the widest cell across a family", () => {
    const [primary, ghost] = familySpecimens([member("Primary", button(), 136), member("Ghost", button(), 100)], dark, false);
    expect(primary).toEqual({
      cellWidth: 136 + 2 * CELL_PAD_X, axis: "size",
      columns: ["dark", "light"].flatMap((theme) => ["sm", "md", "lg"].map((value) => ({ theme, value }))),
    });
    expect(ghost).toEqual(primary);
    expect(specimenWidth({ width: 136, specimen: primary })).toBe(6 * (136 + 2 * CELL_PAD_X));
  });

  it("compares themes only when any member lacks the prop, so no cell is left empty", () => {
    const [primary, link] = familySpecimens([member("Primary", button(), 136), member("Link", `<a>{{label|More}}</a>`, 100)], dark, false);
    expect(primary).toEqual({ cellWidth: 136 + 2 * CELL_PAD_X, axis: null, columns: [{ theme: "dark", value: null }, { theme: "light", value: null }] });
    expect(link).toEqual(primary);
  });

  it("joins members' values in order and blanks the ones a member lacks", () => {
    const [a, b] = familySpecimens([member("A", button("{{size|md|md,lg}}")), member("B", button("{{size|md|sm,md}}"))], plain, false);
    expect(a!.columns.map((c) => c.value)).toEqual(["md", "lg", "sm"]);
    expect(a!.blank).toEqual([2]);
    expect(b!.blank).toEqual([1]);
  });

  it("gives Family/Row/Column members theme cells only, at their own width", () => {
    const [cell] = familySpecimens([member("Primary", button(), 136)], dark, true);
    expect(cell).toEqual({ cellWidth: 136 + 2 * CELL_PAD_X, axis: null, columns: [{ theme: "dark", value: null }, { theme: "light", value: null }] });
  });

  it("keeps one default instance when the cells would be too wide to render", () => {
    expect(familySpecimens([member("Screen", button(), 1440)], dark, false)).toEqual([null]);
    expect(familySpecimens([member("Card", `<b>{{label|Hi}}</b>`, 1200)], dark, false)).toEqual([null]);
    expect(familySpecimens([member("Card", `<b>{{label|Hi}}</b>`, 1000)], dark, false)[0]).not.toBeNull();
  });

  it("keeps a single default instance when there is nothing to compare", () => {
    expect(familySpecimens([member("Primary", `<b>{{label|Hi}}</b>`)], plain, false)).toEqual([null]);
  });
});

describe("examples", () => {
  it("accepts named prop sets for declared props", () => {
    expect(parseExamples([{ name: " Long label ", props: { label: "Send money to Maya" }, width: 160.4 }], button()))
      .toEqual([{ name: "Long label", props: { label: "Send money to Maya" }, width: 160 }]);
    expect(parseExamples(null, button())).toEqual([]);
  });

  it("rejects props the component doesn't declare, duplicates and bad widths", () => {
    expect(() => parseExamples([{ name: "x", props: { tone: "a" } }], button())).toThrow(/does not declare/);
    expect(() => parseExamples([{ name: "x", props: {} }, { name: "x", props: {} }], button())).toThrow(/Two examples/);
    expect(() => parseExamples([{ name: "x", props: {}, width: 4 }], button())).toThrow(/width/);
    expect(() => parseExamples("nope", button())).toThrow(/list/);
  });
});

describe("catalog specimen document", () => {
  const [spec] = familySpecimens([{ id: "p", name: "Button/Primary", width: 136, source: button() }], specimenThemes(".dark{}"), false);

  it("lays out one themed cell per column, each holding an instance with its value", () => {
    const html = catalogSpecimen({ name: "Button/Primary", width: 136 }, "x-button-primary", spec!, specimenThemes(".dark{}"));
    const cells = html.match(/<div class="sp-cell"[^>]*>/g)!;
    expect(cells).toHaveLength(6);
    expect(cells[0]).toContain('data-theme="dark"');
    expect(cells[0]).toContain(`width:${spec!.cellWidth}px`);
    expect(cells[3]).toContain("color-scheme:light");
    expect(html.match(/<x-button-primary size="(\w+)">/g)).toEqual(["sm", "md", "lg", "sm", "md", "lg"].map((v) => `<x-button-primary size="${v}">`));
  });

  it("renders examples under each theme's cells and leaves them out at a fixed height", () => {
    const n = { name: "Button/Primary", width: 136, examples: [{ name: "Long", props: { label: "A <b>" } }] };
    const html = catalogSpecimen(n, "x-button-primary", spec!, specimenThemes(".dark{}"));
    expect(html.match(/class="sp-band"/g)).toHaveLength(2);
    expect(html).toContain('<x-button-primary label="A &lt;b&gt;">');
    expect(catalogSpecimen({ ...n, height: 80 }, "x-button-primary", spec!, specimenThemes(".dark{}"))).not.toContain(`class="sp-band"`);
  });

  it("is what a catalog component renders, and nothing changes outside catalogs", () => {
    expect(renderedHtml({ kind: "component", name: "Button/Primary", width: 136, specimen: spec }, button(), { tokens: ".dark{}" })).toContain("sp-cell");
    expect(renderedHtml({ kind: "component", name: "Button/Primary", width: 136 }, button(), { tokens: ".dark{}" })).toContain("sp-component");
  });
});
