import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../index.html", import.meta.url), "utf8").match(/<script>([\s\S]*?)<\/script>/)![1]!;
const config = { configured: true, publishableKey: `pk_live_${btoa("clerk.sharpner.example$")}`, appOrigin: "https://sharpner.example" };
function start(path = "/f/design", settings = config, status = 200) {
  const window: { __sharpnerAuthConfig?: Promise<typeof config> } = {};
  const json = vi.fn(async () => settings);
  const fetch = vi.fn(async () => ({ ok: status === 200, json }));
  const append = vi.fn();
  runInNewContext(source, { window, fetch, atob, location: { pathname: path, origin: "https://sharpner.example" }, document: {
    createElement: () => ({}), head: { append },
  } });
  return { window, fetch, append, json };
}

describe("early public sign-in bootstrap", () => {
  it("starts before React and shares one parsed response across repeated subscriptions", async () => {
    const { window, fetch, json, append } = start();
    expect(fetch).toHaveBeenCalledWith("/auth/config");
    const [first, second] = await Promise.all([window.__sharpnerAuthConfig, window.__sharpnerAuthConfig]);
    expect(first).toEqual(config);
    expect(second).toBe(first);
    expect(json).toHaveBeenCalledTimes(1);
    expect(append).toHaveBeenCalledTimes(2);
    expect(append.mock.calls[0]![0]).toMatchObject({
      rel: "preload", as: "script", crossOrigin: "anonymous",
      href: "https://clerk.sharpner.example/npm/@clerk/clerk-js@6/dist/clerk.browser.js",
    });
  });

  it("does not fetch account configuration or scripts for a shared view link", () => {
    const { window, fetch } = start("/s/" + "A".repeat(43));
    expect(fetch).not.toHaveBeenCalled();
    expect(window.__sharpnerAuthConfig).toBeUndefined();
  });

  it("does not preload Clerk on an old hostname before the app redirects to its canonical origin", async () => {
    const { window, append } = start("/f/design", { ...config, appOrigin: "https://canonical.example" });
    await window.__sharpnerAuthConfig;
    expect(append).not.toHaveBeenCalled();
  });

  it("retains bootstrap failure for the app's retry flow without preloading scripts", async () => {
    const { window, append } = start("/f/design", config, 503);
    await expect(window.__sharpnerAuthConfig).rejects.toThrow("Sign-in could not be loaded");
    expect(append).not.toHaveBeenCalled();
  });
});
