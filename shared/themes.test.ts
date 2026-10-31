import { describe, expect, it } from "vitest";
import { effectiveTheme, themeNames, validateTheme } from "./themes";
import { frameDocument } from "./types";

describe("theme selection", () => {
  it("discovers unique CSS theme contexts in order, including legacy dark, without reading comments or strings", () => {
    expect(themeNames(`
      /* [data-theme=unused] {} */
      @theme { --font-sans: '.dark [data-theme="quoted"]'; }
      [data-theme=UwU] {} .dark {} [data-theme="UwU"] {}
      .dark-mode {} [data-theme-mode=invalid] {} [data-theme='high contrast'] {}
    `)).toEqual(["light", "UwU", "dark", "high contrast"]);
  });

  it("inherits file themes while retaining screen overrides and foundation comparisons", () => {
    expect(effectiveTheme({ kind: "frame" }, "dark")).toBe("dark");
    expect(effectiveTheme({ kind: "frame", theme: null }, "UwU")).toBe("UwU");
    expect(effectiveTheme({ kind: "frame", theme: "light" }, "dark")).toBe("light");
    expect(effectiveTheme({ kind: "component" }, "dark")).toBe("dark");
    for (const kind of ["tokens", "image", "section"]) expect(effectiveTheme({ kind }, "dark")).toBeUndefined();
    expect(effectiveTheme({ kind: "frame" }, null)).toBeUndefined();
  });

  it("preserves legacy authored appearance until a theme is selected", () => {
    const source = '<main data-theme="dark" class="dark">Screen</main>';
    const original = frameDocument(source);
    expect(frameDocument(source, { theme: null })).toBe(original);
    expect(original).toContain(source);
    const themed = frameDocument(source, { theme: "light" });
    expect(themed).toContain(source);
    expect(themed).toContain(')("light")</script></body>');
    const full = frameDocument(`<!doctype html><html><head></head><body>${source}</body></html>`, { theme: "dark" });
    expect(full).toContain(')("dark")</script></body></html>');
  });

  it("keeps theme names from terminating the generated runtime script", () => {
    const html = frameDocument("<main>Screen</main>", { theme: '</script><script>alert(1)</script>' });
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('\\u003c/script>');
  });

  it.each(["", " ", "x".repeat(81), "dark\n", 12, undefined, {}, ["dark"]])("rejects malformed persisted themes: %j", (value) => {
    expect(() => validateTheme(value)).toThrow(/Theme must/);
  });
});
