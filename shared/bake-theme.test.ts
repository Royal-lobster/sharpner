import { describe, expect, it } from "vitest";
import { bakeTheme } from "./bake-theme";

describe("baking a former theme selection into screen HTML", () => {
  it("wraps fragments in themed document roots", () => {
    expect(bakeTheme("<main>Hi</main>", "dark")).toBe('<html data-theme="dark" class="dark" style="color-scheme:dark"><body data-theme="dark" class="dark"><main>Hi</main></body></html>');
    expect(bakeTheme("<main>Hi</main>", "uwu")).toBe('<html data-theme="uwu"><body data-theme="uwu"><main>Hi</main></body></html>');
  });

  it("replaces authored root themes on full documents, keeping other attributes", () => {
    const source = `<!doctype html><html lang="en" class="dark h-full" data-theme='dark'><head></head><body class="min-h-screen light" style="margin:0;">x</body></html>`;
    expect(bakeTheme(source, "light")).toBe(`<!doctype html><html lang="en" data-theme="light" class="h-full light" style="color-scheme:light"><head></head><body data-theme="light" class="min-h-screen light" style="margin:0">x</body></html>`);
  });

  it("does not touch nested authored theme wrappers or a missing body", () => {
    expect(bakeTheme('<section data-theme="light">a</section>', "dark")).toContain('<section data-theme="light">a</section>');
    expect(bakeTheme("<html><p>a</p></html>", "dark")).toBe('<html data-theme="dark" class="dark" style="color-scheme:dark"><p>a</p></html>');
  });

  it("is idempotent and replaces an earlier baked color scheme", () => {
    const once = bakeTheme("<p>a</p>", "light");
    expect(bakeTheme(bakeTheme(once, "dark"), "dark")).toBe(bakeTheme("<p>a</p>", "dark"));
    expect(bakeTheme('<html style="color: red; color-scheme: light"><body>x</body></html>', "dark")).toContain('style="color: red;color-scheme:dark"');
  });

  it("escapes theme names", () => {
    expect(bakeTheme("<p></p>", 'x"><script>')).toContain('data-theme="x&quot;><script>"');
  });
});
