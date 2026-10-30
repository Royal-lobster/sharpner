# HTML-native design system

Frames are plain HTML, so the design system is HTML too. Components become light-DOM custom elements (`Button/Primary` → `<x-button-primary>`, with props as attributes and a `<slot>` for content). Tokens are Tailwind v4 `@theme` CSS, so frames use them as utilities such as `bg-primary`. We chose this over a structured node schema with per-descendant overrides, like Pencil's `.pen` format. Agents already write HTML and Tailwind fluently, so the browser, the thumbnail renderer, and screenshots all render designs with no custom layout engine.

## Consequences

- An instance is customised only through its props and slot. It can't override arbitrary inner elements, so components must be designed with the props they need.
- A component's tag comes from its name, so renaming a component breaks its existing instances.
