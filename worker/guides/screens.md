# Designing high-quality screens

Product UI should be functional and honest. These rules apply to any product: CRM, fintech, analytics, editor, marketplace, AI tool. For landing pages, see the end of this guide.

## Ground every screen in the design system

- Call `get_design_system` first. Build from component instances (`<x-…>`) and token utilities (`bg-background`, `text-muted-foreground`, `border-border`, `rounded-md`, `font-display`).
- Write bespoke markup for layout and one-off content. Extract repeated feature markup into components on the owning feature page; repetition does not make it a Design System primitive.
- No hardcoded colors or arbitrary values. If a value is missing, add a token.

## Frames and layout on the canvas

- One frame per screen or state. Common widths: **1440** desktop, **1280** compact desktop, **768** tablet, **390** mobile. Give mobile screens a fixed height (844). Leave desktop pages' height empty so they fit their content.
- Use **one page per sizable feature**, keeping its reused components in a separate Components section on that page. Keep the Design System page for foundations and generic primitives. Group screens into **sections per flow** ("Onboarding", "Checkout"), laid out left to right in the order a user moves through them. Give each page and flow section a short description (what it covers, when to look at it), so later agents can navigate with `list_pages`. Put states and variants of one screen (empty, loading, error) next to it.
- **Omit x/y.** New sections use automatic layout: children wrap after four screens (or the row-width limit). A section that contains screens is a flow and always takes its own row, so flows never read as continuations of each other. Other sibling sections (component catalogs, token sheets, groups of them) tile into about √n columns, filled top to bottom. Rows and groups reflow when actual content heights arrive, so agents do not need to estimate positions. Creation appends; use `update_nodes`' `order` to change sibling order. Dragging within an automatic group reorders it. Loose nodes and older sections retain free positioning; use `layout: "free"` on a section to opt out, preserving its current arrangement.
- Name frames clearly: `Checkout · Payment`, `Checkout · Payment · Error`.
- For theme comparisons, place ordinary frames next to each other (`Trade · Light`, `Trade · Dark`, `Trade · UwU`) and set `data-theme` on each frame's HTML root. Reuse the same components and token names; a shared screen component is optional. Keep theme-specific artwork and scoped decoration CSS with the feature. Substantial structural alternatives can remain separate frames.

## Structure

1. **One purpose per screen.** It answers one dominant question and has one primary action.
2. **One dominant region.** Visual weight follows importance. Avoid equal-weight layouts and competing focal points.
3. **Two zones before three.** Sidebar + content, or header + content. Add a third zone only when it earns its place.
4. **Action hierarchy.** One primary button per section. Secondary actions are quieter, destructive actions are distinct, and rare actions go in an overflow menu.
5. **Progressive disclosure.** Show essentials first; reveal advanced controls in context.
6. **Recognition over recall.** Labels beat icon-only buttons, and controls stay in predictable places.

## States are part of the design

Every data-driven surface needs **loading, empty, error, success**, and (when relevant) **no permission** states. Design the important ones as their own frames.

## Rhythm and density

- Spacing comes from Tailwind's scale. A good default: page padding 32 (`p-8`), gaps between sections 24–32, inside cards 20–24, between form fields 16, in button groups 12.
- Pick one density per screen (compact for data-heavy, medium by default, airy for simple flows) and don't mix them.
- Align everything to a shared edge. Use whitespace before dividers, and dividers only when they carry meaning.

## Type and color

- 2–3 type sizes per screen region. Contrast comes from weight and size more than from color.
- Color is semantic. Primary means action. Destructive and success mean exactly that. Muted foreground is for secondary text.
- Keep text contrast readable (WCAG AA at least): `text-muted-foreground` on `bg-muted` must still be legible.

## Content

- Use realistic content: real names, plausible numbers, believable copy. No lorem ipsum and no "Item 1, Item 2".
- Entities (a user, order, document) show their name prominently, a clear status, key metadata, and obvious actions.

## Finish with verification

After each screen: `screenshot_nodes`, then check:
- Nothing is clipped, overflowing, or collapsed.
- There is one clear focal point and one primary action.
- Spacing and alignment are consistent, and contrast is sufficient.
- Styling uses tokens and existing components; new feature components stay with their screens.
Then fix issues by editing the existing frame (`edit_node_source`). Don't recreate it.

## Landing pages and marketing sites

Same system, different goals. Use a clear hero with one message and one call to action, then sections that each prove one thing (features, social proof, pricing, FAQ), and a closing CTA. Use larger type scales and more whitespace. Use `font-display` for headlines if the token sheet defines one. Avoid generic gradients and wrapping everything in cards; give each section a distinct, intentional layout.
