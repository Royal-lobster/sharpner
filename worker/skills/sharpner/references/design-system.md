# Build a design system

## Reuse or create

For a product with several screens, call `get_design_system`. Reuse and extend the existing system. If a workspace library fits, link it with `set_library`.

A single graphic, exploration, or slide can use one token sheet or skip the system.

## Organize the file

Keep the Design System on the ordinary canvas. Use one page named **Design System**, marked with `create_page({ fileId, name: "Design System", kind: "design-system" })` or `update_page({ fileId, pageId, kind: "design-system" })`. The marker identifies primitives; it does not change the canvas view. Changing it preserves every node. Members choose **Use as Design System page** from page options.

Use the same three ordinary sections across files, in this order, plus a fourth when the product has its own art. Add nodes with `sectionId`. Use section `order` values 0, 1, 2 and 3. Keep the names consistent; let the file's brand determine their visual content.

1. **01 · Brand:** one editable HTML frame with the brand name, image logo, one short guidelines paragraph and a few voice bullets. Use the file's tokens and keep it readable at a useful canvas zoom. Keep the corresponding file metadata in `set_brand({ fileId, name, logoUrl, guidelines, voice })` aligned with the frame; changing metadata does not rewrite the frame. Omitted metadata fields stay unchanged; empty strings/arrays clear them. Use `upload_image` for a permanent logo URL. `get_design_system` returns Brand and the marked page ID.
2. **02 · Foundations:** place the file's token sheets here. A token sheet's preview is the file's foundations: shadcn/ui's colour slots, with undeclared slots flagged, then product colours grouped by name, palette ramps, typography, spacing, radius, shadow and motion. Each swatch shows every theme side by side, and a colour with a `-foreground` pair shows its contrast. CSS comments describe tokens. Preserve existing brand-specific token names; alias the shadcn slots to their brand values with `var(...)`. Do not build Colour, Typography or Spacing frames: they duplicate the sheet.
3. **03 · Primitive components:** keep only component definitions in this automatic section. The canvas gives each family a row and one label, lets small families share a row, wraps long rows, and stacks families in columns once the catalog grows much taller than wide, so every Design System page keeps a similar, roughly square shape. Name variants `Family/Variant`. The catalog draws each variant in every compared theme side by side (Dark and Light, when the token CSS declares one as an alternative to its default) and gives each value of a listed prop its own column, so a family reads as a table with theme and value headers. List a prop's values in its placeholder, default first: `{{size|md|sm,md,lg}}`. Add examples and a usage note instead of building boards (see Define components). Keep interaction states (hover, focus, pressed, disabled) out of names: list them in a second prop, `{{state|rest|rest,hover,pressed,focus,disabled}}`, and style each with `[data-state=hover]` beside `:hover`, since a catalog cannot hover. The first listed prop runs across and the second runs down, a row per value. Keep each family's variants contiguous using `order`; rows follow that order. A family named `Family/Row/Column`, such as `Button/Secondary/Large`, still lays out as a table of its variants. Follow the recommended family list below first, then the file's own families. Treat `Radio/*` as Radio Group and `Tab/*` as Tabs when ordering; do not rename existing tags just to match the list. A preview lays out the default instance at the node's width, as a frame of that width does. Set each width to the width the component gets where it is used, and omit fixed height. Keep guidelines, token sheets and product compositions out of this catalog.
4. **04 · Product art style:** when the product has its own illustration, add three to five brochure frames, each in dark and light, that show its illustration language with real examples: the illustration kit, how art sits in promo and hero compositions, photo treatment, data in the brand (how charts and numbers carry the brand, as rules and sketches), and short do and don't rules. Keep them plain frames, not components: product UI such as cards and charts appears only as annotated examples of the style, since the real pieces follow the page they are designed on. Screens draw their art from these frames instead of a component per composition.

Components on the marked Design System page are registered primitives. Agents add them with `create_nodes` on that page or move definitions there with `update_nodes`. The canvas keeps its normal pan, zoom, selection, comments and preview behavior; no separate document view or interaction controls are needed. Previews render exactly the authored HTML; Sharpner keeps its own app theme.

If the file uses a library, read its system with `get_design_system`, and put a short **From library: <name> · Open** link in the Brand guideline frame. Open the library's Design System canvas to edit inherited Brand, token sheets or primitive definitions. Keep this file's additions in its own three sections and label them as local where needed. Do not copy or register duplicate inherited definitions merely to display them: library tokens and components already work in local frames. A local definition with the same tag replaces the library's definitions. Libraries export only their own definitions.

Keep product compositions, explorations and screens on feature pages. Reorganize existing sections and move nodes rather than deleting designs. Inspect existing sources and instance counts before changing component interfaces.

Use the shadcn/ui component set as the recommended list of primitive components. It is a recommendation, not a requirement: build the families the product needs, which may be only a Button and an Input, and register any component the app's screens are built around. Where a family matches the list, use its component and variant names, such as `Button/Default`, `Button/Secondary`, `Button/Outline`, `Button/Ghost`, `Button/Destructive` and `Button/Link`.

- Recommended list: Button, Badge, Input, Textarea, Label, Field, Select, Checkbox, Radio Group, Switch, Slider, Toggle Group, Tabs, Card, Alert, Dialog, Sheet, Drawer, Popover, Tooltip, Dropdown Menu, Avatar, Separator, Skeleton, Spinner, Progress, Table, Toast, Breadcrumb, Pagination, Accordion, and Empty.
- Further shadcn/ui families when screens need them: Command, Combobox, Calendar, Date Picker, Input OTP, Navigation Menu, Menubar, Sidebar, Carousel, Chart, Hover Card, Context Menu, Resizable, Scroll Area, Collapsible, and Kbd.
- Name product-specific compositions after their feature, not after shadcn/ui.

Give each large feature a page for its screens, states, and reused components. Keep product-specific compositions, such as an order form, with that feature.

```text
Design System
├─ 01 · Brand: editable guideline frame
├─ 02 · Foundations: token sheets and themes
└─ 03 · Primitive components: Button/*, Input/*, … (recommended ones first, then the file's own)
Trade
├─ Screens: sections for each flow
└─ Components: Trade/OrderForm, Trade/MarketHeader
```

Describe each page and section: what it contains and when to use it.

Tags apply across the file. Prefix feature component names, such as `Trade/OrderForm` → `<x-trade-orderform>`, to keep them unique.

A library exports all its own tokens and components, regardless of page. Use a separate file for shared foundations and primitives. Libraries do not export their linked library's definitions. Local definitions override library definitions.

Sections with only components form catalogs with one row per family, such as Chip in `Chip/Active`, or one table per family named `Family/Row/Column`, arranged in columns when the catalog is tall. Keep variants together. Use `order` to change sequence. Keep screens and token sheets outside component catalogs. The main skill describes layout.

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

Use shadcn/ui's full theme token set, so shadcn components and agents read the same names:

- Colours: `background`, `foreground`, `card`, `popover`, `primary`, `secondary`, `muted`, `accent` and `destructive`, each with its `-foreground`, plus `border`, `input`, `ring`, `chart-1` to `chart-5`, and `sidebar`, `sidebar-primary`, `sidebar-accent` (each with `-foreground`), `sidebar-border` and `sidebar-ring`.
- Type and shape: `--font-sans`, `--font-serif`, `--font-mono`, `--radius` with `--radius-sm` to `--radius-xl`, `--shadow-2xs` to `--shadow-2xl`, `--tracking-*` and `--spacing`.

Add a product token only when no slot fits, such as `success` or a `yes`/`no` pair, and name it by purpose. Give a fill its `-foreground` text colour. Never make a static token per dynamic entity, such as a category, tag or user: pick those colours from a palette ramp or the chart series in code. The token sheet flags missing slots and notes a product colour that equals a slot in every theme.

This abridged example sets values for a product:

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

/* Named theme contexts. Screens opt in with data-theme on their root. */
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

- Name variants as `Family/Variant`, such as `Button/Ghost` or `Badge/Secondary`. Components have one definition; theme differences go in token values or scoped CSS (see Use themes).
- Use props for content. `{{label|Continue}}` takes the instance's label attribute or the default value.
- List the values of a prop that changes appearance, such as size or tone, after a second `|`: `{{size|md|sm,md,lg}}` (up to eight). Instances still pass one value; catalogs show a column per value when every variant of the family lists that prop, and a row per value of a second such prop, such as state. Give a differently shaped member, such as a full-width or link button, its own family. Prefer one `Button/Ghost` with a size list to `Button/Ghost/Small`, `Button/Ghost/Large` copies.
- Give a component `examples` for edge cases worth seeing: up to eight named prop sets, such as `[{ name: "Long label", props: { label: "Send money to Maya Rodriguez" }, width: 160 }]`. Catalogs show them under the variant. Give the family's first variant a one-line usage `description`, such as "One primary per view"; catalogs show it by the family name.
- Props also work in attributes: `<img src="{{src|/placeholder.png}}">`.
- Use `<slot></slot>` for child content in cards, dialogs, sidebars, and lists.
- Components can contain other component instances.
- Let the parent control layout. Avoid outer margins and fixed page positions. Size to content or use `w-full`.
- Make components dynamic. Express interaction states on the same component with Tailwind variants, such as `hover:`, `focus-visible:`, `active:`, `disabled:`, `aria-invalid:`, `aria-selected:` and `data-[state=open]:`, so instances respond when people use them.
- Do not create a component per state, such as `Button/Default focus` or `Input/Invalid`. Expose states that callers set as props on real attributes, such as `aria-invalid="{{invalid|false}}"` or `data-state="{{state|closed}}"`, and style them with matching variants.
- Keep variants separate from states: `Button/Ghost` is a variant; hover, focus, disabled and error are states of every variant.
- Set the preview width to the width the component gets where it is used. Omit height so the content fits.

```html
<main class="bg-background text-foreground">
  <x-trade-orderform></x-trade-orderform>
  <x-button-primary label="Place order"></x-button-primary>
</main>
```

A catalog shows each variant's cells, examples and usage note; elsewhere a component preview shows only the default instance. Do not hand-build boards of variants, sizes or themes: the catalog generates them from the definitions. The canvas marks them as components; `get_design_system` reports tags, props, listed values, examples and notes. Instances in screens use the original HTML. Token sheets show the foundations: colours, ramps, typography, spacing, radii, shadows and motion.

## Use themes

Define named `[data-theme="…"]` selectors in token CSS. Legacy `.dark` selectors also work. Use the same token names across themes.

Themes can change colors, fonts, radii, and shadows. `get_design_system` returns the declared names; they are CSS contexts a screen can opt into, not a Sharpner setting.

- Themes are authored in HTML: put `data-theme="<name>"` on the screen root, such as `<main data-theme="dark" class="bg-background text-foreground">`. Without it the screen renders unthemed. Token sheets always show every declared theme.
- Compare themes in separate screens, each with its own root theme.
- Prefer token variables, which follow `data-theme`. Tailwind `dark:` utilities follow the viewer's OS setting unless the token CSS declares `@custom-variant dark (&:where([data-theme=dark], [data-theme=dark] *));`.
- Components have one definition. Put theme differences in token values or scoped CSS, such as `[data-theme="uwu"] .trade-chart` or `[data-theme=dark] &`. Use token variables for colors.
- A structurally different alternative is a separate component, such as `Button/Sakura`, or a separate screen.

## Build and maintain

1. Read the existing system or link a library; mark the file’s Design System canvas page.
2. Create or update the Brand guideline frame and its `set_brand` metadata. Put token sheets in Foundations and the primitives needed now in the automatic Primitive components catalog.
3. Check them with `screenshot_nodes` when available.
4. Read `read_skill({ path: "references/screens.md" })` before building screens.
5. Extract repeated feature markup on its feature page. Verify each section of work.

Edit tokens and components in place to update all instances and files that use the library. Call `find_instances` before component changes. A rename changes its tag; update its instances too.
