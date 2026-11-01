import { describe, expect, it } from "vitest";
import { foundations, patchBrand } from "./design-system";
import { emptyBrand } from "./types";

describe("generated foundations", () => {
  it("applies every matching selector in a list, including root defaults shared across themes", () => {
    const result = foundations(':root, .light { --color-primary: blue; --color-background: white; } .dark { --color-background: black; }');
    expect(result.colors.find((t) => t.name === "--color-primary")!.values).toEqual({ light: "blue", dark: "blue" });
    expect(result.colors[0]!.values).toEqual({ light: "white", dark: "black" });
  });

  it("uses specificity and source order instead of always favoring a theme override", () => {
    expect(foundations('.dark { --color-primary: red; } :root { --color-primary: blue; }').vars.dark!["--color-primary"]).toBe("blue");
    expect(foundations(':root.dark { --color-primary: red; } :root { --color-primary: blue; }').vars.dark!["--color-primary"]).toBe("red");
    expect(foundations('.dark { --color-primary: red !important; } :root { --color-primary: blue; }').vars.dark!["--color-primary"]).toBe("red");
    expect(foundations('.dark { --color-primary: red; } @theme { --color-primary: blue; }').vars.dark!["--color-primary"]).toBe("red");
  });

  it("does not promote scoped or conditional overrides into file-wide foundations", () => {
    const result = foundations('@theme { --color-primary: blue; } @media (max-width: 600px) { .dark { --color-primary: red; } } .card .dark { --color-primary: green; } .card { .dark { --color-primary: yellow; } } @layer base { :root { --color-background: white; } }');
    expect(result.vars.dark!["--color-primary"]).toBe("blue");
    expect(result.vars.light!["--color-background"]).toBe("white");
  });

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

describe("brand patches", () => {
  it("keeps omitted fields, trims bullets and validates image URLs and bounds", () => {
    const brand = patchBrand(emptyBrand(), { name: " FraxNet ", voice: [" Plain verbs ", ""], logoUrl: "/a/logo.png" });
    expect(patchBrand(brand, { guidelines: " Paper and ink. " })).toEqual({ name: "FraxNet", voice: ["Plain verbs"], logoUrl: "/a/logo.png", guidelines: "Paper and ink." });
    for (const patch of [{ logoUrl: "javascript:alert(1)" }, { voice: Array(9).fill("a") }, { name: "x".repeat(201) }]) expect(() => patchBrand(brand, patch)).toThrow();
  });
});
