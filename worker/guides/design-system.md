# Building and using a design system

A file's frames draw on **tokens** (named design decisions) and **components** (reusable UI). Keep the **Design System page** focused on foundations and generic primitives; feature components belong beside the screens that use them.

## 1. Decide whether you need one

- **The user is designing a product (an app or website with several screens):** use a design system. First call `get_design_system`. If the file already has one, or uses a **library** (a workspace file shared as a design system), use it and extend it. Never rebuild what exists.
- **A one-off (a single graphic, a quick exploration, one slide):** skip it, or only add a token sheet. Don't force structure onto small files.
- **The workspace has a library that fits the product:** link it with `set_library` instead of creating a new system.

## 2. Where it lives

Create a page named **"Design System"** for foundations and generic primitives: colors, typography, spacing, radii, shadows, buttons, tabs, badges, inputs, and other reusable controls. Build only the primitives the screens need. Describe every page and section in a sentence or two, saying what it holds and when to look at it. Agents read these descriptions through `list_pages`.

```
Design System (page)
├─ Foundations            ← token sheet, including themes
└─ Primitives             ← Button/*, Input/*, Tabs, Badge/*, Checkbox
Trade (page)
├─ Screens                ← trading screens and their states, grouped by flow
└─ Components             ← Trade/OrderForm, Trade/OrderBook, Trade/MarketHeader
Portfolio (page)
├─ Screens                ← portfolio screens and their states, grouped by flow
└─ Components             ← Portfolio/AssetRow, Portfolio/BalanceSummary
```

Give each sizable feature its own page, with its screens, states, and components reused across those screens. Repeated feature markup becomes a component **on that feature page**, not on the Design System page. An order form, market header, or product-specific sidebar belongs with its feature even when several screens use it. Generic controls and empty card/dialog shells belong in the Design System; product-specific compositions do not.

This is an organization convention: component tags are still file-wide. Prefix feature components with their feature (`Trade/OrderForm` → `<x-trade-orderform>`) to keep names distinct. A library exports every token sheet and component in its file, regardless of page; use a separate foundations-and-primitives file when sharing a library across products.

Create sections without coordinates and add nodes with `sectionId`. New sections arrange their children automatically in creation order, wrapping rows after four previews. A section that holds only components becomes a **catalog**: specimens pack tightly, each family (`Chip` in `Chip/Active`) starts its own row with the family named once in a left gutter, and each specimen is labelled with its variant. Keep a family's variants adjacent and keep screens or token sheets out of component sections, so the catalog applies. Sibling sections without screens (nested catalog groups, and top-level sections like Tokens and Components) tile into about √n columns, filled top to bottom in order (ten groups → columns of 3, 3, 2, 2), so Tokens sits beside Components and the catalogs fill the page instead of forming one tall column. Measured preview heights move a section down its column but never into another one. Sections that contain screens are flows and keep a row each. A page that also has free sections or loose nodes keeps its automatic top-level sections in one column, so switch hand-placed groups back to `layout: "auto"` to let them tile. Leave groups in automatic sections: don't wrap them in a free section to place them by hand, because automatic layout already tiles catalogs and groups. Use `order` only when changing the sequence. Older sections keep their authored free layout until `update_nodes` sets `layout: "auto"`; `layout: "free"` opts out while preserving the current positions.

## 3. Tokens: one token sheet, semantic names

Create a node with `kind: "tokens"` whose source is Tailwind v4 CSS. Every `--color-*`, `--font-*`, `--radius-*`, `--shadow-*` and `--text-*` you declare in `@theme` becomes a utility (`bg-primary`, `text-muted-foreground`, `font-display`, `rounded-card`, `shadow-elevated`) in every frame and component of the file (and of files using it as a library).

Name tokens by **role**, never by value (`primary`, not `blue-600`). Start from this skeleton and set real values for the brand:

```css
@theme {
  --color-background: #ffffff;        /* page */
  --color-foreground: #0a0a0a;        /* primary text */
  --color-muted: #f4f4f5;             /* subtle surfaces */
  --color-muted-foreground: #71717a;  /* secondary text */
  --color-card: #ffffff;
  --color-border: #e4e4e7;
  --color-primary: #4f46e5;           /* brand, main actions */
  --color-primary-foreground: #ffffff;
  --color-secondary: #f4f4f5;
  --color-secondary-foreground: #18181b;
  --color-accent: #f59e0b;
  --color-destructive: #dc2626;
  --color-success: #16a34a;
  --color-warning: #d97706;

  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --font-display: "Instrument Serif", serif;   /* optional personality */
  --font-mono: "JetBrains Mono", ui-monospace, monospace;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
  --radius-pill: 999px;

  --shadow-elevated: 0 8px 30px rgb(0 0 0 / 0.08);
}

/* Named theme: same tokens, new values. Frames opt in with data-theme="dark" on their root. */
[data-theme="dark"] {
  --color-background: #09090b;
  --color-foreground: #fafafa;
  --color-muted: #18181b;
  --color-muted-foreground: #a1a1aa;
  --color-card: #111113;
  --color-border: #27272a;
  --color-secondary: #27272a;
  --color-secondary-foreground: #fafafa;
}

[data-theme="uwu"] {
  --color-background: #1b1942;
  --color-foreground: #f5eaff;
  --color-muted: #29255b;
  --color-muted-foreground: #bdb2d8;
  --color-card: #211d4a;
  --color-border: #51437d;
  --color-primary: #a3eadf;
  --color-primary-foreground: #153c38;
  --radius-md: 999px;
  --shadow-elevated: 0 8px 30px rgb(186 144 238 / 0.2);
}
```

Themes can change fonts, radii, and shadows as well as colors. Use the same token names across themes. A frame selects one with a root such as `<main data-theme="dark" class="bg-background text-foreground">…</main>`; omit the attribute for the default light presentation. Existing `.dark` overrides and `class="dark"` roots also work.

Load web fonts with an `@import url("https://fonts.googleapis.com/css2?family=…")` line at the very top of the token sheet.

**Rule:** frames and components use token utilities only: `bg-background`, `text-foreground`, `border-border`, `rounded-md`. Hardcoded hex values, arbitrary colors (`bg-[#123456]`) and raw palette classes (`bg-indigo-600`) break theming and consistency. Tailwind's default spacing scale (4px steps) is the spacing system. Stick to it rather than arbitrary values.

## 4. Components

A component is a node with `kind: "component"`. Its name becomes its tag: `Button/Primary` → `<x-button-primary>`.

- **Name as `Family/Variant`**: `Button/Primary`, `Button/Ghost`, `Badge/Success`. These are component variants; light, dark, and uwu are themes of the same component. Do not duplicate every component for each theme. Keep feature names prefixed, such as `Trade/OrderForm`.
- **Props** carry content: `{{label|Continue}}` is replaced by the instance's `label="…"` attribute, or the default. Props also work inside attributes: `<img src="{{src|/placeholder.png}}">`.
- **Slots** carry composition: `<slot></slot>` is replaced by whatever the instance wraps. Cards, modals, sidebars and list containers use slots.
- **Layout-neutral**: no outer margins or fixed page positions. Size to content, or take `w-full` so the parent decides.
- **Token-only styling**, so themes and library changes flow through.
- **Compose**: components can use other components (`<x-card>` containing `<x-button-primary>`).
- **States worth seeing** (hover, focus, disabled, selected, error) get their own variants when a screen needs to show them: `Field/Error`, `Button/Primary · Disabled`.
- Give each component node a sensible canvas `width` (the context it's usually used in) and leave `height` empty.

Component nodes display their default instance on the file's own background, with a small caption for the tag and props/slot information. Give them an auto height so the preview can fit its content and caption; old short fixed-height nodes use a compact preview. Keep variants in creation order inside a named group section ("Actions", "Inputs", "Selection"); the catalog layout rows them by family name and sizes rows from their measured heights.

Token sheets display as foundations catalogs, including per-theme swatches and resolved values, typography, spacing, radii, and shadows. Declare named `[data-theme="…"]` overrides to show those themes beside the default Light pane; `.dark` also produces a Dark pane. Preview presentation is separate from component definitions: instances in screens keep the original component HTML without the specimen caption.

Instances in frames:

```html
<main data-theme="uwu" class="bg-background text-foreground">
  <x-trade-orderform></x-trade-orderform>
  <x-button-primary label="Place order"></x-button-primary>
</main>
```

## 5. Order of work

1. `get_design_system`. Reuse what exists, link a library if the workspace has a fitting one.
2. Token sheet and the primitives needed for the current screens. Screenshot them (`screenshot_nodes`) and check contrast and harmony.
3. Create or open the feature page, then build its screens (see `read_guide("screens")`). Extract repeated feature markup into components on that page as needed; do not prebuild a catalog of application components.
4. Screenshot each section of work and fix problems before moving on.

For richer themes, keep value changes in the token sheet and feature-specific decoration in the feature component's CSS, scoped with a selector such as `[data-theme="uwu"] .trade-chart`. Use token variables for its colors. An uwu chart can add stars, clouds, or artwork without changing its data or layout. Compare themes in ordinary neighboring frames; they can reuse a screen component when useful, but extracting an entire screen is optional. If a presentation changes the structure substantially, use an alternate frame instead of forcing it through tokens.

## 6. Maintaining it

- Change the system in one place (the token sheet or the component). Every instance, and every file using this file as a library, re-renders.
- Renaming a component changes its tag, so update its instances (find them with `read_nodes` on the screens) or keep the name.
- Add a component variant for a reusable control appearance or state; use a theme for presentation changes across controls and screens. Keep feature-specific changes on the owning feature page.
