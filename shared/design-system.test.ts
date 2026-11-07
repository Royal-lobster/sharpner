import { describe, expect, it } from "vitest";
import { COLOR_SLOTS, durationMs, easeCurve, foundations, patchBrand, resolveToken, sheetColumns, tokenSheet } from "./design-system";
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

  it("reads a block's own tokens when it also holds nested blocks, such as keyframes in @theme", () => {
    const result = foundations(`@theme {
      --font-display: "Sora"; /* Headlines and big numbers */
      @keyframes pop { from { opacity: 0 } to { opacity: 1 } }
      --text-6xl: 60px;
      --radius-card: 16px;
      @media (max-width: 600px) { --radius-card: 12px; }
    } :root { --color-primary: lime; .card { --color-primary: red; } }`);
    expect(result.type.map((t) => t.name)).toEqual(["--font-display", "--text-6xl"]);
    expect(result.type[0]!.description).toBe("Headlines and big numbers");
    // Nested conditional and scoped declarations stay out of the file-wide values.
    expect(result.radii[0]!.values).toEqual({ light: "16px" });
    expect(result.vars.light!["--color-primary"]).toBe("lime");
    expect(result.vars.light!["opacity"]).toBeUndefined();
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

/** Like tupredices: the root is dark, `.light` and a named light theme switch to light, and a block maps the roles. */
const darkRootSheet = `
  :root, [data-theme="tupredices"] { --background: #1a1d20; --card: #202428; --foreground: #fff; --lime-9: #d4ff00; }
  .light, [data-theme="light"], [data-theme="tupredices-light"] { --background: #fff; --card: #f4f5f6; --foreground: #1a1d20; --lime-9: #c0db00; }
  :root, .light, [data-theme], [data-brand] { --color-background: var(--background); --color-card: var(--card); --color-foreground: var(--foreground); --color-primary: var(--lime-9); }`;

/** A stock shadcn v4 globals.css: the root is light and `.dark` overrides it; `@theme inline` maps the roles. */
const shadcnSheet = `
  :root { --background: oklch(1 0 0); --foreground: oklch(0.145 0 0); --radius: 0.625rem; }
  .dark { --background: oklch(0.145 0 0); --foreground: oklch(0.985 0 0); }
  @theme inline { --color-background: var(--background); --color-foreground: var(--foreground); --radius-sm: calc(var(--radius) - 4px); }`;

describe("token sheet theme columns", () => {
  it("reads a root that only declares a light alternative as dark, and merges themes with identical values", () => {
    const columns = sheetColumns(darkRootSheet);
    expect(columns.map(({ key, names, label, scheme }) => ({ key, names, label, scheme }))).toEqual([
      { key: "", names: ["dark", "tupredices"], label: "Dark · Tupredices", scheme: "dark" },
      { key: "light", names: ["light", "tupredices-light"], label: "Light · Tupredices-light", scheme: "light" },
    ]);
    expect(columns[0]!.vars["--color-background"]).toBe("var(--background)");
    expect(columns[0]!.vars["--background"]).toBe("#1a1d20");
    expect(columns[1]!.vars["--background"]).toBe("#fff");
  });

  it("reads shadcn's root as Light and `.dark` as Dark, with Dark first", () => {
    const columns = sheetColumns(shadcnSheet);
    expect(columns.map(({ key, label, scheme }) => ({ key, label, scheme }))).toEqual([
      { key: "dark", label: "Dark", scheme: "dark" },
      { key: "light", label: "Light", scheme: "light" },
    ]);
    expect(columns[0]!.vars["--background"]).toBe("oklch(0.145 0 0)");
    expect(columns[1]!.vars["--background"]).toBe("oklch(1 0 0)");
  });

  it("names a column after every theme with identical values and keeps distinct themes apart", () => {
    const columns = sheetColumns('@theme { --color-primary: red; } [data-theme="brand"] { --color-primary: red; } [data-theme="uwu"] { --color-primary: pink; }');
    expect(columns.map((c) => c.label)).toEqual(["Light · Brand", "Uwu"]);
    expect(sheetColumns("@theme { --color-primary: red; }").map((c) => c.label)).toEqual(["Light"]);
  });
});

describe("token sheet contents", () => {
  it("puts the full shadcn theme first, pairs foregrounds and flags slots the sheet does not declare", () => {
    expect(COLOR_SLOTS).toHaveLength(32);
    const sheet = tokenSheet(darkRootSheet);
    const base = sheet.color.slots.find((g) => g.name === "base")!;
    expect(base.items.map((c) => c.name)).toEqual(["background", "foreground", "card", "popover", "primary", "secondary", "muted", "accent", "destructive", "border", "input", "ring"]);
    const card = base.items.find((c) => c.name === "card")!;
    expect(card).toMatchObject({ foreground: "card-foreground", foregroundToken: null });
    expect(card.token!.values).toEqual({ "": "var(--card)", light: "var(--card)" });
    expect(base.items.find((c) => c.name === "ring")!.token).toBeNull();
    expect(sheet.color.slots.map((g) => [g.name, g.items.length])).toEqual([["base", 12], ["chart", 5], ["sidebar", 5]]);
    expect(sheet.color.declared).toBe(4);
  });

  it("groups product additions by first name segment, pairs their foregrounds and notes ones equal to a slot", () => {
    const sheet = tokenSheet(`@theme {
      --color-background: #111; --color-card: var(--surface); --color-primary: #d4ff00;
      --color-yes: #93d17b; --color-yes-foreground: #111; --color-yes-soft: color-mix(in oklab, var(--color-yes) 16%, transparent);
      --color-panel: var(--surface); --color-primary-text: #d4ff00;
      --color-chart-6: #ffc107; --color-chart-grid: #2d3238;
    } :root { --surface: #202428; } .dark { --color-primary-text: #fff; }`);
    expect(sheet.color.additions.map((g) => [g.name, g.items.map((c) => c.name)])).toEqual([
      ["yes", ["yes", "yes-soft"]], ["panel", ["panel"]], ["primary", ["primary-text"]], ["chart", ["chart-6", "chart-grid"]],
    ]);
    const yes = sheet.color.additions[0]!.items[0]!;
    expect(yes).toMatchObject({ foreground: "yes-foreground" });
    expect(yes.foregroundToken!.name).toBe("--color-yes-foreground");
    // Resolved through var() chains in every theme; primary-text differs in dark, so it is its own decision.
    expect(sheet.color.additions[1]!.items[0]!.same).toEqual(["card"]);
    expect(sheet.color.additions[2]!.items[0]!.same).toEqual([]);
    expect(sheet.color.extra).toBe(7);
  });

  it("finds palette ramps of five or more numbered colour steps outside --color-", () => {
    const sheet = tokenSheet(`:root {
      --lime-1: #181b0f; --lime-2: #1e2311; --lime-3: #242b0d; --lime-4: #293209; --lime-10: #c5ed00; --lime-5: color-mix(in oklab, var(--lime-4) 50%, white);
      --gray-1: #111; --gray-2: #222; --gray-3: #333; --gray-4: #444;
      --chart-1: red; --chart-2: blue; --chart-3: green; --chart-4: pink; --chart-5: tan;
      --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 20px;
    } @theme { --color-chart-1: var(--chart-1); }`);
    expect(sheet.ramps).toEqual([{ name: "lime", steps: [1, 2, 3, 4, 5, 10].map((step) => ({ step, name: `--lime-${step}` })) }]);
  });

  it("reads type, spacing, radius, shadow and motion tokens", () => {
    const sheet = tokenSheet(`@theme {
      --font-sans: Figtree; --font-display: Sora; --font-weight-bold: 700; --font-sans--font-feature-settings: "ss01";
      --tracking-tight: -0.02em;
      --text-sm: 13px; --text-sm--line-height: 18px; --text-6xl: 3.75rem; --text-2xl: 22px; --text-body: var(--x);
      --text-icon: 16px; --text-icon-lg: 20px; --text-icon--line-height: 1;
      --spacing: 4px; --spacing-gutter: 24px;
      --radius: 0.625rem; --radius-sm: calc(var(--radius) - 4px);
      --shadow-popover: 0 8px 24px #0005; --inset-shadow-pressed: inset 0 2px 4px #0004;
      --duration-fast: 120ms; --duration-slow: 0.3s; --duration-odd: var(--d);
      --ease-out: cubic-bezier(0.23, 1, 0.32, 1); --ease-in: ease-in; --ease-step: steps(4);
      --animate-pop: pop-in 200ms ease-out;
    }`);
    expect(sheet.fonts.map((t) => t.name)).toEqual(["--font-sans", "--font-display"]);
    expect(sheet.weights.map((t) => t.name)).toEqual(["--font-weight-bold"]);
    expect(sheet.tracking.map((t) => t.utility)).toEqual(["tracking-tight"]);
    // Largest first, with the display family for big sizes and the line height beside its size.
    expect(sheet.text.map((s) => [s.token.name, s.px, s.display, s.lineHeight?.name ?? null])).toEqual([
      ["--text-6xl", 60, true, null], ["--text-2xl", 22, true, null], ["--text-sm", 13, false, "--text-sm--line-height"], ["--text-body", null, false, null],
    ]);
    expect(sheet.icons.map((t) => t.name)).toEqual(["--text-icon", "--text-icon-lg"]);
    expect(sheet.spacing).toMatchObject({ base: { name: "--spacing" }, steps: [1, 2, 3, 4, 6, 8, 12, 16] });
    expect(sheet.spacing.named.map((t) => t.name)).toEqual(["--spacing-gutter"]);
    expect(tokenSheet("@theme { --color-primary: red; }").spacing.base).toBeNull();
    expect(sheet.radii.map((t) => [t.name, t.utility])).toEqual([["--radius", "rounded"], ["--radius-sm", "rounded-sm"]]);
    expect(sheet.shadows.map((t) => t.name)).toEqual(["--shadow-popover", "--inset-shadow-pressed"]);
    expect(sheet.motion.durations.map((d) => [d.token.name, d.ms])).toEqual([["--duration-fast", 120], ["--duration-slow", 300], ["--duration-odd", null]]);
    expect(sheet.motion.eases.map((e) => e.curve)).toEqual([[0.23, 1, 0.32, 1], [0.42, 0, 1, 1], null]);
    expect(sheet.motion.animations.map((t) => t.utility)).toEqual(["animate-pop"]);
  });

  it("parses CSS times, easing keywords and var() chains", () => {
    expect([durationMs("150ms"), durationMs(".2s"), durationMs("fast")]).toEqual([150, 200, null]);
    expect([easeCurve("linear"), easeCurve("ease"), easeCurve("ease-out"), easeCurve("ease-in-out"), easeCurve("cubic-bezier(0.34, 1.5, 0.64, 1)"), easeCurve("cubic-bezier(1, 2)")])
      .toEqual([[0, 0, 1, 1], [0.25, 0.1, 0.25, 1], [0, 0, 0.58, 1], [0.42, 0, 0.58, 1], [0.34, 1.5, 0.64, 1], null]);
    expect(resolveToken("color-mix(in oklab, var(--a) 12%, var(--missing, transparent))", { "--a": "var(--b)", "--b": "#D4FF00" })).toBe("color-mix(in oklab,#d4ff00 12%,transparent)");
    expect(resolveToken("var(--loop)", { "--loop": "var(--loop)" })).toBe("var(--loop)");
  });
});

describe("brand patches", () => {
  it("keeps omitted fields, trims bullets and validates image URLs and bounds", () => {
    const brand = patchBrand(emptyBrand(), { name: " FraxNet ", voice: [" Plain verbs ", ""], logoUrl: "/a/logo.png" });
    expect(patchBrand(brand, { guidelines: " Paper and ink. " })).toEqual({ name: "FraxNet", voice: ["Plain verbs"], logoUrl: "/a/logo.png", guidelines: "Paper and ink." });
    for (const patch of [{ logoUrl: "javascript:alert(1)" }, { voice: Array(9).fill("a") }, { name: "x".repeat(201) }]) expect(() => patchBrand(brand, patch)).toThrow();
  });
});
