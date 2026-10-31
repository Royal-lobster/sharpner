import { describe, expect, it } from "vitest";
import { canonicalFamily, foundations, livePreviewIds, MAX_LIVE_PREVIEWS, patchBrand, primitiveFamilies } from "./design-system";
import { componentTag, emptyBrand, mergeDesignSystems, type CanvasNode, type DesignSystem, type LibraryInfo } from "./types";

const node = (name: string, pageId = "ds", theme: string | null = null): CanvasNode => ({ id: name + (theme ?? ""), name, pageId, theme, kind: "component", parentId: null, x: 0, y: 0, width: 400, height: null, measuredHeight: null, thumbLo: null, thumbHi: null, src: null, rev: 1 });
const designFor = (nodes: CanvasNode[]): DesignSystem => ({ tokens: "", components: nodes.map((n) => ({ tag: componentTag(n.name), html: '<button class="hover:bg-primary focus-visible:ring active:scale-95 disabled:opacity-50">{{label|Go}}<slot></slot></button>', theme: n.theme })) });

describe("generated foundations", () => {
  it("orders defined recommended slots first and resolves theme inheritance, aliases and comment descriptions", () => {
    const css = `@theme {
      --color-brand-z: #456;
      --color-ring: var(--color-brand-z);
      --color-primary: #abc; /* Main action */
      /* The page surface */
      --color-background: #fff;
      --font-sans: Archivo;
      --text-body: 16px;
      --spacing: 4px;
      --radius-control: 8px;
      --shadow-control: 0 1px 2px #0002;
    }
    [data-theme="dark"] { --color-background: #111; --color-primary: #def; --radius-control: 12px; }
    /* --color-fake: red; */`;
    const result = foundations(css);
    expect(result.themes).toEqual(["light", "dark"]);
    expect(result.colors.map((t) => t.name)).toEqual(["--color-background", "--color-primary", "--color-ring", "--color-brand-z"]);
    expect(result.colors[0]).toMatchObject({ description: "The page surface", values: { light: "#fff", dark: "#111" } });
    expect(result.colors[1]).toMatchObject({ description: "Main action", utility: "bg-primary", values: { light: "#abc", dark: "#def" } });
    expect(result.colors[2]).toMatchObject({ description: "", utility: "ring-ring", values: { light: "var(--color-brand-z)", dark: "var(--color-brand-z)" } });
    expect(result.type.map((t) => t.name)).toEqual(["--font-sans", "--text-body"]);
    expect(result.spacing[0]).toMatchObject({ utility: "p-1" });
    expect(result.radii[0]!.values.dark).toBe("12px");
    expect(result.shadows).toHaveLength(1);
  });

  it("merges library and local tokens and marks local additions and overrides", () => {
    const library = '@theme { --color-background: white; --color-primary: blue; --font-sans: Inter; } .dark { --color-background: black; }';
    const local = '@theme { --color-primary: purple; --color-brand: pink; }';
    const result = foundations(library + local, local);
    expect(result.colors.map((t) => [t.name, t.local])).toEqual([["--color-background", false], ["--color-primary", true], ["--color-brand", true]]);
    expect(result.colors[0]!.values).toEqual({ light: "white", dark: "black" });
    expect(result.colors[1]!.values).toEqual({ light: "purple", dark: "purple" });
    expect(result.type[0]!.local).toBe(false);
  });

  it("ignores commented declarations and resets, and supports named themes with spaces", () => {
    const result = foundations(`@theme { /* --color-fake: red; */ --color-primary: blue; --color-gone: initial; --radius: 6px; }
      [data-theme="warm grey"] { --color-primary: tan; }
      :root { /* --color-another-fake: red; */ }`);
    expect(result.colors.map((t) => t.name)).toEqual(["--color-primary"]);
    expect(result.colors[0]!.values["warm grey"]).toBe("tan");
    expect(result.radii[0]).toMatchObject({ name: "--radius", utility: "rounded" });
  });
});

describe("primitive catalogs", () => {
  it("uses placement, groups variants and keeps theme overrides alongside the default", () => {
    const nodes = [node("Price/Yes"), node("Radio/Checked"), node("Tab/Default"), node("Button/Ghost"), node("Button/Default", "ds", "dark"), node("Button/Default"), node("Feature/Card", "screens"), node("Input/Default")];
    const families = primitiveFamilies(nodes, "ds", designFor(nodes), null);
    expect(families.map((f) => f.name)).toEqual(["Button", "Input", "Radio Group", "Tabs", "Price"]);
    const defaults = families[0]!.variants.find((v) => v.name === "Default")!;
    expect(defaults.definitions.map((p) => p.node.theme)).toEqual([null, "dark"]);
    expect(defaults.definitions[0]).toMatchObject({ props: [{ name: "label", defaults: ["Go"] }], slot: true, library: false });
    expect(canonicalFamily("radio-group")).toBe("Radio Group");
    expect(canonicalFamily("Toggle")).toBe("Toggle Group");
  });

  it("includes library primitives, marks ownership and replaces every library definition for a local tag", () => {
    const inherited = [node("Button/Default"), node("Button/Default", "ds", "dark"), node("Input/Default"), node("Radio/Default")];
    const local = [node("Button/Default", "local"), node("Price/Yes", "local")];
    const library: LibraryInfo = { fileId: "lib", name: "fraxnet", design: designFor(inherited), catalog: { brand: { ...emptyBrand(), name: "FraxNet" }, pageId: "ds", primitives: inherited, tokenSheets: 1 } };
    const merged = mergeDesignSystems(library.design, designFor(local));
    const families = primitiveFamilies(local, "local", merged, library);
    expect(families.map((f) => f.name)).toEqual(["Button", "Input", "Radio Group", "Price"]);
    expect(families[0]!.variants[0]!.definitions).toHaveLength(1);
    expect(families[0]!.variants[0]!.definitions[0]!.library).toBe(false);
    expect(families[1]!.variants[0]!.definitions[0]!.library).toBe(true);
    expect(primitiveFamilies([], "local", library.design, library)).toHaveLength(3);
    // Local feature definitions still own their tag under the existing merge rule.
    expect(primitiveFamilies([node("Input/Default", "feature")], "local", merged, library).some((f) => f.name === "Input")).toBe(false);
  });
});

describe("live preview budget", () => {
  it("mounts only visible previews and never exceeds its hard budget, even with hundreds visible", () => {
    const ids = Array.from({ length: 400 }, (_, n) => `preview-${n}`);
    expect(livePreviewIds(ids, new Set()).size).toBe(0);
    expect(livePreviewIds(ids, new Set(ids)).size).toBe(MAX_LIVE_PREVIEWS);
    const scrolled = livePreviewIds(ids, new Set(ids.slice(120, 125)));
    expect([...scrolled]).toEqual(ids.slice(120, 125));
    expect([...scrolled].some((id) => ids.slice(0, MAX_LIVE_PREVIEWS).includes(id))).toBe(false);
  });
});

describe("brand patches", () => {
  it("keeps omitted fields, trims bullets and validates image URLs and bounds", () => {
    const brand = patchBrand(emptyBrand(), { name: " FraxNet ", voice: [" Plain verbs ", ""], logoUrl: "/a/logo.png" });
    expect(patchBrand(brand, { guidelines: " Paper and ink. " })).toEqual({ name: "FraxNet", voice: ["Plain verbs"], logoUrl: "/a/logo.png", guidelines: "Paper and ink." });
    for (const patch of [{ logoUrl: "javascript:alert(1)" }, { voice: Array(9).fill("a") }, { name: "x".repeat(201) }]) expect(() => patchBrand(brand, patch)).toThrow();
  });
});
