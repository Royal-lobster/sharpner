import { describe, expect, it } from "vitest";
import { themeNames } from "./themes";
import { frameDocument, renderedHtml } from "./types";

describe("theme selection", () => {
  it("discovers unique CSS theme contexts in order, including legacy dark, without reading comments or strings", () => {
    expect(themeNames(`
      /* [data-theme=unused] {} */
      @theme { --font-sans: '.dark [data-theme="quoted"]'; }
      [data-theme=UwU] {} .dark {} [data-theme="UwU"] {}
      .dark-mode {} [data-theme-mode=invalid] {} [data-theme='high contrast'] {}
    `)).toEqual(["light", "UwU", "dark", "high contrast"]);
  });

  it("ships one definition per component and leaves authored HTML untouched", () => {
    const source = '<main data-theme="dark" class="dark"><x-button></x-button></main>';
    const html = frameDocument(source, { design: { tokens: "", components: [{ tag: "x-button", html: "<button>Go</button>" }] } });
    expect(html).toContain('"x-button":"\\u003cbutton>Go\\u003c/button>"');
    expect(html).toContain(source);
    expect(html).not.toContain("__sharpnerTheme");
    expect(renderedHtml({ kind: "component", name: "Button/Primary" }, "<button>Go</button>")).toContain("<x-button-primary></x-button-primary>");
  });
});

describe("prepared thumbnail fonts", () => {
  it("emits embedded font faces as plain CSS, outside the Tailwind source", () => {
    const html = frameDocument("<p>Hi</p>", { compiledTailwind: true, fontCss: "@font-face{font-family:Inter;src:url(data:font/woff2;base64,AQID)}", design: { tokens: "@theme { --font-sans: Inter; }", components: [] } });
    expect(html).toContain('<style data-sharpner-fonts>@font-face{font-family:Inter;src:url(data:font/woff2;base64,AQID)}</style>');
    expect(html).toMatch(/<style type="text\/tailwindcss">@theme static \{ --font-sans: Inter; \}<\/style>/);
    expect(html).not.toContain("<link");
  });
});
