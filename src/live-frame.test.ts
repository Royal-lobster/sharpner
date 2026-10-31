import { describe, expect, it } from "vitest";
import { canRethemeFrame } from "./live-frame";
import type { DesignSystem } from "../shared/types";

const design: DesignSystem = { tokens: '@theme { --color-primary: purple; } [data-theme="dark"] { --color-primary: pink; }', components: [{ tag: "x-button", html: '<button class="bg-primary">{{label|Continue}}</button>' }] };

describe("live frame theme eligibility", () => {
  it("allows the real component runtime, props, slots, and authored nested contexts", () => {
    expect(canRethemeFrame('<main class="dark"><x-button label="Start"></x-button><section data-theme="light"><x-button></x-button></section></main>', design)).toBe(true);
    expect(canRethemeFrame('<style>x-button:defined { display:contents }</style><x-button></x-button>', design)).toBe(true);
  });

  it("falls back for structural theme definitions, including unused definitions", () => {
    expect(canRethemeFrame("<main>Screen</main>", { ...design, components: [...design.components, { tag: "x-card", theme: "dark", html: "<article>Alternative</article>" }] })).toBe(false);
  });

  it.each([
    '<script>document.body.textContent="Authored"</script>',
    '<script type="module" src="/screen.js"></script>',
    '<button onclick="run()">Go</button>',
    '<a href="javascript:run()">Go</a>',
    '<iframe src="https://example.com"></iframe>',
    '<object data="/screen.svg"></object>',
    '<link rel="stylesheet" href="/screen.css">',
    '<meta http-equiv="Content-Security-Policy" content="script-src none">',
    '<div style="background-image:url(/hero.png)"></div>',
    '<style>[data-theme="dark"] { background-image:image-set("/dark.png" 1x) }</style>',
    '<style>@import "/screen.css";</style>',
  ])("preserves unsupported authored behavior on the fresh-document path: %s", (html) => {
    expect(canRethemeFrame(html, design)).toBe(false);
  });

  it("checks component behavior and token assets, rather than only frame markup", () => {
    expect(canRethemeFrame("<x-button></x-button>", { ...design, components: [{ tag: "x-button", html: '<button onfocus="run()">Go</button>' }] })).toBe(false);
    expect(canRethemeFrame("<main>Screen</main>", { ...design, tokens: '[data-theme="dark"] { background-image:url(/dark.png) }' })).toBe(false);
  });

  it("allows web fonts because the runtime can roll back a cold-font update", () => {
    const tokens = '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap"); @font-face { font-family:Local; src:url(/font.woff2) }';
    expect(canRethemeFrame("<main>Screen</main>", { ...design, tokens })).toBe(true);
  });
});
