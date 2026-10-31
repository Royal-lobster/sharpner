# Build a design system

## Reuse or create

For a product with several screens, call `get_design_system`. Reuse and extend the existing system. If a workspace library fits, link it with `set_library`.

A single graphic, exploration, or slide can use one token sheet or skip the system.

## Organize the file

Keep foundations and generic primitives on a page named Design System.

Base primitives on the shadcn/ui component set. Use its component names and variant names, such as `Button/Default`, `Button/Secondary`, `Button/Outline`, `Button/Ghost`, `Button/Destructive` and `Button/Link`. In a shared design-system file, cover the core set below. In a product file without a library, add the primitives its current screens need.

- Core set: Button, Badge, Input, Textarea, Label, Field, Select, Checkbox, Radio Group, Switch, Slider, Toggle Group, Tabs, Card, Alert, Dialog, Sheet, Drawer, Popover, Tooltip, Dropdown Menu, Avatar, Separator, Skeleton, Spinner, Progress, Table, Toast, Breadcrumb, Pagination, Accordion, and Empty.
- Add others from shadcn/ui when screens need them: Command, Combobox, Calendar, Date Picker, Input OTP, Navigation Menu, Menubar, Sidebar, Carousel, Chart, Hover Card, Context Menu, Resizable, Scroll Area, Collapsible, and Kbd.
- Name product-specific compositions after their feature, not after shadcn/ui.

Give each large feature a page for its screens, states, and reused components. Keep product-specific compositions, such as an order form, with that feature.

```text
Design System
├─ Foundations: tokens and themes
└─ Primitives: Button/*, Input/*, Tabs, Badge/* (shadcn/ui names)
Trade
├─ Screens: sections for each flow
└─ Components: Trade/OrderForm, Trade/MarketHeader
```

Describe each page and section: what it contains and when to use it.

Tags apply across the file. Prefix feature component names, such as `Trade/OrderForm` → `<x-trade-orderform>`, to keep them unique.

A library exports all its own tokens and components, regardless of page. Use a separate file for shared foundations and primitives. Libraries do not export their linked library's definitions. Local definitions override library definitions.

Create automatic sections and omit coordinates. Sections with only components form catalogs with one row per family, such as Chip in `Chip/Active`. Keep variants together. Use `order` to change sequence. Keep screens and token sheets outside component catalogs. The main skill describes automatic and free layout.

## Define tokens

Create a `kind: "tokens"` node with Tailwind v4 CSS in `source`.

Variables in `@theme` become utilities throughout the file and files that use it as a library:

| Variable | Utility |
| --- | --- |
| `--color-primary` | `bg-primary` |
| `--color-muted-foreground` | `text-muted-foreground` |
| `--font-display` | `font-display` |
| `--radius-card` | `rounded-card` |
| `--shadow-elevated` | `shadow-elevated` |
| `--text-title` | `text-title` |

Name tokens by purpose, such as primary. Set these example values for the product:

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

/* Named theme overrides. Select with a frame theme or the file theme. */
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

Put web-font `@import url("https://fonts.googleapis.com/css2?family=…")` declarations before all other CSS.

Use token utilities in frames and components. Avoid hardcoded colors, arbitrary color values, and raw palette classes. Use Tailwind's spacing scale in 4px steps.

## Define components

Create a `kind: "component"` node with HTML in `source`. Its name sets the tag: `Button/Primary` → `<x-button-primary>`.

- Name variants as `Family/Variant`, such as `Button/Ghost` or `Badge/Secondary`. Themes do not need duplicate component definitions; override only components whose structure differs in a theme (see Use themes).
- Use props for content. `{{label|Continue}}` takes the instance's label attribute or the default value.
- Props also work in attributes: `<img src="{{src|/placeholder.png}}">`.
- Use `<slot></slot>` for child content in cards, dialogs, sidebars, and lists.
- Components can contain other component instances.
- Let the parent control layout. Avoid outer margins and fixed page positions. Size to content or use `w-full`.
- Make components dynamic. Express interaction states on the same component with Tailwind variants, such as `hover:`, `focus-visible:`, `active:`, `disabled:`, `aria-invalid:`, `aria-selected:` and `data-[state=open]:`, so instances respond when people use them.
- Do not create a component per state, such as `Button/Default focus` or `Input/Invalid`. Expose states that callers set as props on real attributes, such as `aria-invalid="{{invalid|false}}"` or `data-state="{{state|closed}}"`, and style them with matching variants.
- Keep variants separate from states: `Button/Ghost` is a variant; hover, focus, disabled and error are states of every variant.
- Set a suitable preview width. Omit height so content and captions fit.

```html
<main class="bg-background text-foreground">
  <x-trade-orderform></x-trade-orderform>
  <x-button-primary label="Place order"></x-button-primary>
</main>
```

Component previews add tag and prop captions. Instances in screens use the original HTML without captions. Token sheets show foundation previews: theme swatches, typography, spacing, radii, and shadows.

## Use themes

Define named `[data-theme="…"]` selectors in token CSS. Legacy `.dark` selectors also work. Use the same token names across themes.

Themes can change colors, fonts, radii, and shadows. `get_design_system` returns their names.

- Use `set_theme({ fileId, theme: "dark" })` for the file default. Frames and component previews inherit it.
- Set a frame's `theme` to override the file. Set it to null to restore inheritance.
- A null file theme preserves authored HTML themes. Token sheets always show every theme.
- Keep new frame roots unthemed, such as `<main class="bg-background text-foreground">`.
- The selected theme replaces outer authored theme contexts and preserves nested markup.
- Nested light content in a dark frame needs explicit light token overrides in CSS.
- Compare themes in separate frames with explicit theme fields. A file theme change then preserves those choices.

Keep feature decoration in CSS with a scoped selector, such as `[data-theme="uwu"] .trade-chart`. Use token variables for colors. A shared screen component is optional.

When a theme changes a component's structure, such as extra decoration elements, slots, or a different layout, add a theme override: create a component with the same name and `theme: "uwu"`. Instances inside that theme use it; other themes keep the default, so create the default first. Keep the same props and slot so instances work in every theme, and leave value differences to the token sheet. `get_design_system` lists overrides under `themeOverrides`. Use a separate frame when a whole screen's structure differs.

## Build and maintain

1. Read the existing system or link a library.
2. Create tokens and the primitives needed now.
3. Check them with `screenshot_nodes` when available.
4. Read `read_skill({ path: "references/screens.md" })` before building screens.
5. Extract repeated feature markup on its feature page. Verify each section of work.

Edit tokens and components in place to update all instances and files that use the library. Call `find_instances` before component changes. A rename changes its tag; update its instances too.
