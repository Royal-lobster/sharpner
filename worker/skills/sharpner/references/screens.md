# Design screens and covers

## Build from the design system

Call `get_design_system`. Use existing components and token utilities such as `bg-background`, `text-foreground`, `border-border`, and `rounded-md`.

Use custom HTML for layout and unique content. Extract repeated feature markup into components on the feature page. Keep generic primitives on the Design System page. Add a token when a required value is missing.

## Arrange screens

- Use one page per large feature, with sections for each flow, such as Onboarding or Checkout.
- Keep screens, states, and feature components on that page. Describe each page and section.
- Use one frame per screen or state. Name frames by task: `Checkout · Payment` or `Checkout · Payment · Error`.
- Put screens left to right in flow order. Keep related states together. Omit x/y in automatic sections; use `order` to change sequence.
- Use viewport widths of 1440 for desktop, 1280 for compact desktop, 768 for tablet, or 390 for mobile.
- Use a fixed mobile height of 844. Omit desktop height to fit content.

Set the file theme with `set_theme`. Use explicit frame `theme` fields for comparisons such as Light, Dark, and UwU. Null restores inheritance. Leave new HTML roots unthemed so frames can inherit. Components use the screen's theme.

Keep theme decoration with its feature. Reuse a screen component when useful. Use a separate frame for a different structure.

## Set visual priorities

- Give each screen one purpose, one main region, and one primary action. Use secondary styles for other actions.
- Start with two layout regions, such as a sidebar and content. Add a third only when needed.
- Show essential controls first. Put advanced controls in context. Label actions and keep controls in consistent positions.
- Distinguish destructive actions. Put rare actions in an overflow menu.
- Show loading, empty, error, success, and permission states when they apply. Use separate frames.

Use Tailwind spacing. Start with 32px page padding, 24–32px section gaps, 20–24px card padding, 16px field gaps, and 12px button gaps. Use one density per screen. Align content to shared edges. Add dividers only when they clarify structure.

Use two or three type sizes per region. Use size and weight for hierarchy. Reserve primary color for actions. Use destructive and success colors for those meanings. Meet WCAG AA text contrast, including muted text on muted surfaces.

Use realistic names, numbers, and copy. Show each entity's name, status, key details, and actions. Avoid placeholder text.

## Create a file cover

1. Check `get_file.cover`. Preserve an existing choice unless asked to replace it.
2. For a new product file, create a described Cover page and an editable 1600 × 900 frame.
3. Use the product's tokens and fonts. Show its name, a short description, and one image or design detail that identifies it.
4. Keep the title readable on a small workspace card. Avoid dense screenshots, small labels, and generic decoration.
5. Inspect it with `screenshot_nodes`. Fix clipping and overflow, then call `set_cover({ fileId, nodeId })`.

Update the established cover when the product's identity changes. The choice follows source and preview updates, including pending previews. Use `nodeId: null` for automatic selection. Deleting its node or containing section or page also restores automatic selection. Work elsewhere preserves the chosen cover.

## Verify the result

After each screen, call `screenshot_nodes` when available. Check clipping, overflow, visual focus, spacing, alignment, contrast, and component use. Fix the existing frame with `edit_node_source`.

## Landing pages

Start with one message and one call to action. Follow with sections for evidence, such as features, customer results, pricing, and FAQ. End with a call to action. Use more space and larger type than product screens. Use `font-display` when defined. Give each section a purpose; avoid generic gradients and repeated card layouts.
