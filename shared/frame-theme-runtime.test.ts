import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { documentThemeScript, frameThemeReply, type FrameThemeReply } from "./themes";
import { frameDocument } from "./types";

class Element {
  readonly attrs = new Map<string, string>();
  readonly children: Element[] = [];
  height = 128;
  constructor(readonly parentElement: Element | null, attrs: Record<string, string> = {}) {
    for (const [key, value] of Object.entries(attrs)) this.attrs.set(key, value);
    parentElement?.children.push(this);
  }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  removeAttribute(name: string) { this.attrs.delete(name); }
  get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
  get dataset() {
    const attrs = this.attrs;
    return { set theme(value: string) { attrs.set("data-theme", value); } };
  }
  get classList() {
    const values = () => (this.attrs.get("class") ?? "").split(/\s+/).filter(Boolean);
    return {
      contains: (value: string) => values().includes(value),
      remove: (...names: string[]) => this.attrs.set("class", values().filter((name) => !names.includes(name)).join(" ")),
      add: (name: string) => this.attrs.set("class", [...new Set([...values(), name])].join(" ")),
    };
  }
  get style() {
    const attrs = this.attrs;
    return { set colorScheme(value: string) { attrs.set("style", `${attrs.get("style") ?? ""};color-scheme:${value}`); } };
  }
  closest(_selector: string): Element | null {
    if (this.attrs.has("data-theme") || this.classList.contains("dark") || this.classList.contains("light")) return this;
    return this.parentElement?.closest(_selector) ?? null;
  }
  querySelectorAll(_selector: string): Element[] {
    return this.children.flatMap((child) => [...(_selector === "*" || child.closest(_selector) === child ? [child] : []), ...child.querySelectorAll(_selector)]);
  }
  getBoundingClientRect() { return { height: this.height }; }
}

function fixture(initial: string | null, fontsReady: Promise<unknown> = Promise.resolve()) {
  const html = new Element(null, { class: "app dark", style: "padding:3px;color-scheme:dark", "data-theme": "authored" });
  const body = new Element(html);
  const outer = new Element(body, { class: "dark outer", style: "padding:2px" });
  const nested = new Element(outer, { class: "light nested", "data-theme": "light" });
  const sibling = new Element(body, { "data-theme": "candy" });
  const elements = [html, body, outer, nested, sibling];
  const original = elements.map((element) => Object.fromEntries(element.attrs));
  const messages: FrameThemeReply[] = [];
  const parent = { postMessage: (data: FrameThemeReply) => messages.push(data) };
  const window = {};
  const documentListeners = new Map<string, (() => void)[]>();
  const listeners = new Map<string, ((event: unknown) => void)[]>();
  const timers: (() => void)[] = [];
  const observers: (() => void)[] = [];
  const fonts = { ready: fontsReady, status: "loaded" };
  const images: { complete: boolean }[] = [];
  const document = {
    documentElement: html, body, fonts, images, readyState: "loading",
    addEventListener: (name: string, callback: () => void) => documentListeners.set(name, [...documentListeners.get(name) ?? [], callback]),
  };
  const channel = { token: "frame-secret", generation: 0 };
  const script = documentThemeScript(initial, channel).replace(/^<script>|<\/script>$/g, "");
  runInNewContext(script, {
    window, document, parent,
    addEventListener: (name: string, callback: (event: unknown) => void) => listeners.set(name, [...listeners.get(name) ?? [], callback]),
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; },
    ResizeObserver: class { constructor(callback: () => void) { observers.push(callback); } observe() {} },
  });
  const command = (theme: string | null, generation: number, source: unknown = parent, token = channel.token) => {
    for (const listener of listeners.get("message") ?? []) listener({ source, data: { type: "sharpner:frame-theme", token, generation, theme } });
  };
  const runTimers = () => { for (const timer of timers.splice(0)) timer(); };
  const boot = (finishTimers = true) => {
    document.readyState = "interactive";
    for (const listener of documentListeners.get("DOMContentLoaded") ?? []) listener();
    document.readyState = "complete";
    for (const listener of listeners.get("load") ?? []) listener({});
    if (finishTimers) runTimers();
  };
  return { html, body, outer, nested, sibling, elements, original, messages, fonts, images, window, channel, command, boot, runTimers, resize: () => observers.forEach((observer) => observer()) };
}

const flush = async () => { await Promise.resolve(); await Promise.resolve(); };

describe("shared persistent document theme runtime", () => {
  it("restores exact authored roots/wrappers through Dark, Light and As authored", async () => {
    const f = fixture("dark");
    f.boot();
    const nested = Object.fromEntries(f.nested.attrs);
    f.command("light", 1);
    await flush();
    expect(f.html.getAttribute("data-theme")).toBe("light");
    expect(f.outer.getAttribute("class")).toBe("outer light");
    expect(f.sibling.getAttribute("data-theme")).toBe("light");
    expect(Object.fromEntries(f.nested.attrs)).toEqual(nested);
    f.command(null, 2);
    await flush();
    expect(f.elements.map((element) => Object.fromEntries(element.attrs))).toEqual(f.original);
    expect(f.window).toMatchObject({ __sharpnerTheme: undefined });
    expect(f.messages.at(-1)).toMatchObject({ type: "sharpner:frame-ready", generation: 2, height: 128 });
  });

  it("starts As authored without adding attributes and captures them before the first update", async () => {
    const f = fixture(null);
    f.boot();
    expect(f.elements.map((element) => Object.fromEntries(element.attrs))).toEqual(f.original);
    f.command("light", 1);
    f.command(null, 2);
    await flush();
    expect(f.elements.map((element) => Object.fromEntries(element.attrs))).toEqual(f.original);
  });

  it("rejects other windows, tokens and stale commands", async () => {
    const f = fixture("dark");
    f.boot();
    f.command("light", 1, {});
    f.command("light", 1, undefined, "wrong-token");
    f.command("light", 0);
    await flush();
    expect(f.html.getAttribute("data-theme")).toBe("dark");
    expect(f.messages).toHaveLength(1);
  });

  it("only acknowledges the newest update and tags later height changes with its generation", async () => {
    let resolve!: () => void;
    const f = fixture("dark", new Promise<void>((done) => { resolve = done; }));
    f.boot();
    f.command("light", 1);
    f.command(null, 2);
    f.body.height = 240;
    f.resize();
    expect(f.messages.map((message) => message.generation)).toEqual([0]);
    resolve();
    await flush();
    expect(f.messages.filter((message) => message.type === "sharpner:frame-ready").map((message) => message.generation)).toEqual([0, 2]);
    f.body.height = 320;
    f.resize();
    expect(f.messages.at(-1)).toMatchObject({ type: "sharpner:frame-height", generation: 2, height: 320 });
  });

  it.each(["font", "image"])("rolls back before painting and requests a replacement for a cold %s", (asset) => {
    const f = fixture("dark");
    f.boot();
    const previous = f.elements.map((element) => Object.fromEntries(element.attrs));
    if (asset === "font") f.fonts.status = "loading";
    else f.images.push({ complete: false });
    f.command("light", 1);
    expect(f.elements.map((element) => Object.fromEntries(element.attrs))).toEqual(previous);
    expect(f.messages.at(-1)).toMatchObject({ type: "sharpner:frame-reload", generation: 1 });
  });

  it("retains the bounded load-based initial reveal when fonts never settle", () => {
    const f = fixture("dark", new Promise(() => {}));
    f.boot();
    expect(f.messages).toEqual([{ ...f.channel, type: "sharpner:frame-ready", height: 128 }]);
  });

  it("does not let the initial load timer acknowledge a later theme command", async () => {
    let resolve!: () => void;
    const f = fixture("dark", new Promise<void>((done) => { resolve = done; }));
    f.boot(false);
    f.command("light", 1);
    f.runTimers();
    expect(f.messages).toEqual([]);
    resolve();
    await flush();
    expect(f.messages).toEqual([{ ...f.channel, generation: 1, type: "sharpner:frame-ready", height: 128 }]);
  });

  it("rejects executable attributes produced by expanded props before attempting a theme update", () => {
    const f = fixture("dark");
    new Element(f.body, { onclick: "authoredBehavior()" });
    f.boot();
    f.command("light", 1);
    expect(f.html.getAttribute("data-theme")).toBe("dark");
    expect(f.messages.at(-1)).toMatchObject({ type: "sharpner:frame-reload", generation: 1 });
  });

  it("adds control only on request and keeps the actual shared component expansion", () => {
    const design = { tokens: "", components: [{ tag: "x-button", html: "<button>Go</button>" }] };
    const legacy = frameDocument("<x-button></x-button>", { design, theme: "dark", measure: true });
    expect(legacy).toContain("parent.postMessage({sharpnerHeight:n}");
    const controlled = frameDocument("<x-button></x-button>", { design, theme: "dark", measure: true, themeChannel: { token: "unique-channel", generation: 0 } });
    expect(controlled).toContain("customElements.define");
    expect(controlled).toContain('"token":"unique-channel"');
    expect(controlled).not.toContain("parent.postMessage({sharpnerHeight:n}");
  });
});

describe("frame reply validation", () => {
  it("requires the current source, channel and generation and a finite nonnegative height", () => {
    const source = {} as Window;
    const channel = { token: "current", generation: 3 };
    const data = { type: "sharpner:frame-ready", ...channel, height: 120 };
    expect(frameThemeReply({ source, data }, source, channel)).toEqual(data);
    expect(frameThemeReply({ source: {} as Window, data }, source, channel)).toBeNull();
    expect(frameThemeReply({ source, data: { ...data, token: "other" } }, source, channel)).toBeNull();
    expect(frameThemeReply({ source, data: { ...data, generation: 2 } }, source, channel)).toBeNull();
    for (const height of [NaN, Infinity, -1, "120", undefined]) expect(frameThemeReply({ source, data: { ...data, height } }, source, channel)).toBeNull();
    expect(frameThemeReply({ source, data: { ...data, type: "unexpected" } }, source, channel)).toBeNull();
    expect(frameThemeReply({ source, data: { ...channel, type: "sharpner:frame-reload" } }, source, channel)).toMatchObject({ type: "sharpner:frame-reload" });
  });
});
