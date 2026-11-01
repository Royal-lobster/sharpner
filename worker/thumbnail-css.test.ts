import { describe, expect, it } from "vitest";
import { thumbnailCss } from "./thumbnail-css";
import { frameDocument } from "../shared/types";

describe("compiled thumbnail styles", () => {
  it("compiles real DOM candidates with static tokens, arbitrary utilities and authored CSS", async () => {
    const input = '@theme static {--color-primary:#123456} [data-theme="dark"] {--color-primary:#abcdef} .card { @apply rounded-xl p-4; }';
    const css = await thumbnailCss(input,["bg-primary","w-[37px]","dark:text-white"]);
    expect(css).toContain("--color-primary: #123456");
    expect(css).toContain("background-color: var(--color-primary)");
    expect(css).toContain("width: 37px");
    expect(css).toContain(".card");
    expect(css).toContain("padding:");
    // Incremental builds retain previous candidates and add classes created by component props.
    const expanded = await thumbnailCss(input,["text-red-500"]);
    expect(expanded).toContain(".text-red-500"); expect(expanded).toContain(".bg-primary");
  });
  it("supports the browser build's stylesheet imports and rejects plugins and unsupported imports", async () => {
    expect(await thumbnailCss('@import "tailwindcss"; @theme static {--color-brand:red}',["text-brand"])).toContain("color: var(--color-brand)");
    await expect(thumbnailCss('@import "custom";',[])).rejects.toThrow("does not support @import");
    await expect(thumbnailCss('@plugin "example";',[])).rejects.toThrow("does not support plugins");
  });
  it("keeps the shared document path and live compiler version aligned", () => {
    const html = '<main class="bg-primary"><x-button></x-button></main>';
    const options = {base:"https://example.com",design:{tokens:"@theme {--color-primary:red}",components:[{tag:"x-button",html:"<button>Go</button>"}]},theme:"dark"};
    const live = frameDocument(html,options);
    const thumbnail = frameDocument(html,{...options,compiledTailwind:true,tailwindCss:".bg-primary {color:red}"});
    expect(live).toContain("@tailwindcss/browser@4.3.3");
    expect(thumbnail).not.toContain("cdn.jsdelivr.net");
    expect(thumbnail).toContain("data-sharpner-css");
    expect(thumbnail).toContain(html);
  });
});
