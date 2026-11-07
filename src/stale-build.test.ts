import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { message } = vi.hoisted(() => ({ message: vi.fn() }));
vi.mock("sonner", () => ({ toast: { message } }));

import { reloadIfStale } from "./stale-build";

describe("stale tabs", () => {
  let store: Map<string, string>;
  let active: unknown;
  beforeEach(() => {
    store = new Map();
    active = null;
    class Field {}
    vi.stubGlobal("HTMLInputElement", Field);
    vi.stubGlobal("HTMLTextAreaElement", class {});
    vi.stubGlobal("sessionStorage", { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) });
    vi.stubGlobal("document", { get activeElement() { return active; } });
    message.mockReset();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reloads once when the room runs a different build, and never in development", () => {
    const reload = vi.fn();
    expect(reloadIfStale("b2", "b1", reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    // A reload that still lands on the old bundle (a cached asset) must not loop.
    expect(reloadIfStale("b2", "b1", reload)).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(reloadIfStale("b1", "b1", reload)).toBe(false);
    expect(reloadIfStale("b3", "dev", reload)).toBe(false);
    expect(reloadIfStale(undefined, "b1", reload)).toBe(false);
  });

  it("asks instead of reloading while someone is typing", () => {
    const reload = vi.fn();
    active = new (globalThis as unknown as { HTMLInputElement: new () => unknown }).HTMLInputElement();
    expect(reloadIfStale("b2", "b1", reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledWith(expect.stringMatching(/updated/), expect.objectContaining({ action: expect.objectContaining({ label: "Reload" }) }));
  });
});
