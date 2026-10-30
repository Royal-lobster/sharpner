# Building and using a design system

A design system is a file's **tokens** (named design decisions) plus its **components** (reusable UI). Frames built from them look consistent, are faster to make, and update together when the system changes.

## 1. Decide whether you need one

- **The user is designing a product (an app or website with several screens):** use a design system. First call `get_design_system`. If the file already has one, or uses a **library** (a workspace file shared as a design system), use it and extend it. Never rebuild what exists.
- **A one-off (a single graphic, a quick exploration, one slide):** skip it, or only add a token sheet. Don't force structure onto small files.
- **The workspace has a library that fits the product:** link it with `set_library` instead of creating a new system.

## 2. Where it lives

Put it on its own page named **"Design System"** (create it with `create_page`), organised with sections. Describe the page and each section in a sentence or two, saying what it holds and when to look at it (e.g. page: "Token sheet and component catalogs grouped by role. Check before building any screen."; section "Forms": "Fields, selects and validation states for every form."). Agents read these descriptions through `list_pages` to find their way around the file.

```
Design System (page)
├─ Section "Tokens"       ← one token sheet
└─ Section "Components"
   ├─ Section "Buttons"   ← Button/Primary, Button/Secondary, Button/Ghost, Button/Destructive, Icon Button
   ├─ Section "Inputs"    ← Field, Select, Checkbox, Toggle, Search
   ├─ Section "Navigation"← Sidebar, Nav Item, Nav Item/Active, Tabs, Top Bar
   ├─ Section "Display"   ← Card, Badge/*, Avatar, List Row, Stat
   └─ Section "Feedback"  ← Alert/*, Toast, Empty State, Skeleton
```

Screens go on other pages (e.g. "Screens", or one page per platform), in sections per flow.

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

/* Dark theme: same names, new values. Frames opt in with class="dark" on their root. */
.dark {
  --color-background: #09090b;
  --color-foreground: #fafafa;
  --color-muted: #18181b;
  --color-muted-foreground: #a1a1aa;
  --color-card: #111113;
  --color-border: #27272a;
  --color-secondary: #27272a;
  --color-secondary-foreground: #fafafa;
}
```

Load web fonts with an `@import url("https://fonts.googleapis.com/css2?family=…")` line at the very top of the token sheet.

**Rule:** frames and components use token utilities only: `bg-background`, `text-foreground`, `border-border`, `rounded-md`. Hardcoded hex values, arbitrary colors (`bg-[#123456]`) and raw palette classes (`bg-indigo-600`) break theming and consistency. Tailwind's default spacing scale (4px steps) is the spacing system. Stick to it rather than arbitrary values.

## 4. Components

A component is a node with `kind: "component"`. Its name becomes its tag: `Button/Primary` → `<x-button-primary>`.

- **Name as `Family/Variant`**: `Button/Primary`, `Button/Ghost`, `Badge/Success`, `Nav Item/Active`. Make a separate component per visual variant, rather than one component with styling props.
- **Props** carry content: `{{label|Continue}}` is replaced by the instance's `label="…"` attribute, or the default. Props also work inside attributes: `<img src="{{src|/placeholder.png}}">`.
- **Slots** carry composition: `<slot></slot>` is replaced by whatever the instance wraps. Cards, modals, sidebars and list containers use slots.
- **Layout-neutral**: no outer margins or fixed page positions. Size to content, or take `w-full` so the parent decides.
- **Token-only styling**, so themes and library changes flow through.
- **Compose**: components can use other components (`<x-card>` containing `<x-button-primary>`).
- **States worth seeing** (hover, focus, disabled, selected, error) get their own variants when a screen needs to show them: `Field/Error`, `Button/Primary · Disabled`.
- Give each component node a sensible canvas `width` (the context it's usually used in) and leave `height` empty.

Component nodes display their default instance on the file's own background, with a small caption for the tag and props/slot information. Give them an auto height so the preview can fit its content and caption; old short fixed-height nodes use a compact preview. Keep variants in creation order inside a named group section ("Actions", "Inputs", "Selection"); the catalog layout rows them by family name and sizes rows from their measured heights.

Token sheets display as foundations catalogs, including per-theme swatches and resolved values, typography, spacing, radii, and shadows. Declare a real `.dark` or `[data-theme="dark"]` override to show light and dark specimens together. Preview presentation is separate from component definitions: instances in screens keep the original component HTML without the specimen caption.

Instances in frames:

```html
<x-card title="Assets">
  <x-list-row title="USDC" meta="Ethereum" value="1,204.50"></x-list-row>
</x-card>
<x-button-primary label="Add money"></x-button-primary>
```

## 5. Order of work

1. `get_design_system`. Reuse what exists, link a library if the workspace has a fitting one.
2. Token sheet. Screenshot it (`screenshot_nodes`) and check contrast and harmony.
3. Primitives: buttons, inputs, badges, avatars, icon buttons.
4. Composites: navigation, cards, list/table rows, dialogs, empty states.
5. Screenshot each component section and fix problems before moving on.
6. Screens built from instances (see `read_guide("screens")`). When markup repeats twice in screens, promote it to a component.

## 6. Maintaining it

- Change the system in one place (the token sheet or the component). Every instance, and every file using this file as a library, re-renders.
- Renaming a component changes its tag, so update its instances (find them with `read_nodes` on the screens) or keep the name.
- Prefer adding a variant over adding one-off styling to a single screen.
