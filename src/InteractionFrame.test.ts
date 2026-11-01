import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InteractionFrame } from "./InteractionFrame";

afterEach(() => vi.unstubAllGlobals());
const props = { id: "screen-one", html: "<button>Go</button>", design: { tokens: "", components: [] }, theme: "dark", width: 400, height: 700, onStop: () => {} };
const render = () => {
  vi.stubGlobal("location", { origin: "https://sharpner.test" });
  return renderToStaticMarkup(createElement(InteractionFrame, props));
};

describe("interaction frame admission", () => {
  it("starts hidden in an opaque sandbox with local form events and fixed geometry", () => {
    const html = render();
    expect(html).toContain('sandbox="allow-scripts allow-forms"');
    expect(html).not.toContain("allow-same-origin");
    expect(html).toContain('data-interaction-id="screen-one"');
    expect(html).not.toContain("data-id=");
    expect(html).toContain('tabindex="-1"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("width:400px;height:700px;opacity:0;pointer-events:none");
    expect(html).not.toContain("sharpnerHeight");
    expect(html).toContain('class="interaction-loading" role="status"');
  });

  it("gives every mount a new document and channel, so a new key restarts the session", () => {
    const first = render();
    const reset = render();
    expect(reset).not.toBe(first);
    expect(first).toContain("data-sharpner-playback-bridge");
    expect(reset).toContain("data-sharpner-playback-bridge");
  });
});
