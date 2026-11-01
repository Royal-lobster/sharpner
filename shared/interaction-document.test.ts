import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { interactionDocument, interactionReply, INTERACTION_SANDBOX, type InteractionReply } from "./interaction-document";
import type { DesignSystem } from "./types";

const design: DesignSystem = { tokens: '@theme { --color-primary: purple; }', components: [{ tag: "x-button", html: "<button>{{label|Go}}</button>" }] };
const options = { base: "https://sharpner.test", token: "playback-token", design };

describe("interaction document", () => {
  it.each([
    '<x-button></x-button><script>window.authorMarker=1</script>',
    '<!doctype html><html lang="en" class="dark"><head><base href="https://other.test/"></head><body class="authored"><script>window.authorMarker=1</script></body></html>',
    '<!doctype html><script>window.authorMarker=1</script><main>Malformed document</main>',
  ])("places the policy and trusted bridge before any authored code: %s", (html) => {
    const doc = interactionDocument(html, options);
    expect(doc.startsWith("<!doctype html><base")).toBe(true);
    const policy = doc.indexOf('http-equiv="Content-Security-Policy"');
    const bridge = doc.indexOf("data-sharpner-playback-bridge");
    expect(policy).toBeGreaterThan(doc.indexOf('<base href="https://sharpner.test/"'));
    expect(bridge).toBeGreaterThan(policy);
    expect(doc.indexOf("window.authorMarker")).toBeGreaterThan(bridge);
    expect(doc.slice(0, bridge)).not.toContain("</head>");
    expect(doc).toContain("customElements.define");
  });

  it("keeps authored HTML/root/body attributes while preventing a later policy from relaxing its restrictions", () => {
    const html = '<!doctype html><html lang="ja" dir="rtl" class="dark"><head><meta http-equiv="Content-Security-Policy" content="default-src *"></head><body class="screen" style="background:red">Content</body></html>';
    const doc = interactionDocument(html, options);
    expect(doc).toContain('<html lang="ja" dir="rtl" class="dark">');
    expect(doc).toContain('<body class="screen" style="background:red">');
    expect(doc.indexOf("connect-src 'none'")).toBeLessThan(doc.indexOf('content="default-src *"'));
    expect(doc).toContain('content="default-src *"');
  });

  it("disables API connections, forms, base changes and child runtimes while retaining display assets", () => {
    // The policy is an attribute value; compare it as the browser parses it.
    const doc = interactionDocument("<main>Screen</main>", options).replaceAll("&#39;", "'");
    for (const directive of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "media-src 'none'"]) expect(doc).toContain(directive);
    expect(doc).toContain("script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3");
    expect(doc).toContain("style-src 'unsafe-inline' https: https://sharpner.test");
    expect(doc).toContain("img-src data: blob: https: https://sharpner.test");
    expect(doc).toContain("font-src data: blob: https: https://sharpner.test");
    expect(doc).not.toContain("'unsafe-eval'");
    expect(doc).not.toContain("navigate-to");
    expect(doc).not.toContain("sharpnerHeight");
    expect(INTERACTION_SANDBOX).toBe("allow-scripts allow-forms");
  });

  it("normalizes the trusted asset base to the HTTP(S) origin and escapes its channel", () => {
    const token = '</script><script>untrusted()</script>';
    const doc = interactionDocument("<main>Screen</main>", { ...options, base: "http://localhost:5200/f/file?private=1", token });
    expect(doc).toContain('<base href="http://localhost:5200/" target="_self">');
    expect(doc).not.toContain("private=1");
    expect(doc).not.toContain(token);
    expect(doc).toContain("\\u003c/script>");
    expect(() => interactionDocument("", { ...options, base: "javascript:alert(1)" })).toThrow(/HTTP/);
  });

  it("recreates content and design through the ordinary frameDocument renderer", () => {
    const first = interactionDocument("<main>Before</main>", options);
    const content = interactionDocument("<main>After</main>", options);
    const definition = interactionDocument("<main>Before</main>", { ...options, design: { ...design, components: [{ tag: "x-button", html: "<strong>Updated</strong>" }] } });
    expect(content).not.toBe(first);
    expect(content).toContain("<main>After</main>");
    expect(definition).not.toBe(first);
    expect(definition).toContain("Updated");
  });
});

function bridgeFixture(fonts = Promise.resolve()) {
  const messages: InteractionReply[] = [];
  const parent = { postMessage: (data: InteractionReply) => messages.push(data) };
  const listeners = new Map<string, ((event: Record<string, unknown>) => void)[]>();
  const timers: { callback: () => void; delay: number }[] = [];
  const scrolled: string[] = [];
  class Element {
    constructor(readonly href: string | null = null) {}
    matches() { return this.href !== null; }
    getAttribute() { return this.href; }
  }
  const script = interactionDocument("<main>Screen</main>", options).match(/<script data-sharpner-playback-bridge>([\s\S]*?)<\/script>/)![1]!;
  const context: Record<string, unknown> = {
    parent, Element,
    document: { fonts: { ready: fonts }, getElementById: (id: string) => ({ scrollIntoView: () => scrolled.push(id) }) },
    addEventListener: (name: string, listener: (event: Record<string, unknown>) => void) => listeners.set(name, [...listeners.get(name) ?? [], listener]),
    setTimeout: (callback: () => void, delay: number) => { timers.push({ callback, delay }); return timers.length; },
  };
  runInNewContext(script, context);
  const dispatch = (name: string, values: Record<string, unknown> = {}) => {
    let prevented = false, blocked = false;
    const event = { isTrusted: true, composedPath: () => [], ...values, preventDefault: () => { prevented = true; }, stopImmediatePropagation: () => { blocked = true; } };
    for (const listener of listeners.get(name) ?? []) { listener(event); if (blocked) break; }
    return { prevented, blocked };
  };
  const runTimers = (delay: number) => {
    for (const timer of timers.filter((timer) => timer.delay === delay)) timer.callback();
    for (let i = timers.length - 1; i >= 0; i--) if (timers[i]!.delay === delay) timers.splice(i, 1);
  };
  const start = (source: unknown = parent, token = options.token) => dispatch("message", { source, data: { type: "sharpner:interaction-start", token } });
  return { messages, parent, Element, scrolled, dispatch, runTimers, start, context };
}

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("trusted interaction bridge", () => {
  it("gates trusted input until both readiness and the scoped parent acknowledgment", async () => {
    const f = bridgeFixture();
    expect(f.dispatch("click")).toEqual({ prevented: true, blocked: true });
    expect(f.dispatch("click", { isTrusted: false })).toEqual({ prevented: false, blocked: false });
    f.start();
    expect(f.dispatch("keydown", { key: "a" }).blocked).toBe(true);
    f.dispatch("load");
    await flush();
    f.runTimers(120);
    expect(f.messages).toEqual([{ type: "sharpner:interaction-ready", token: options.token }]);
    f.start({});
    expect(f.dispatch("click").blocked).toBe(true);
    f.start(undefined, "wrong-token");
    expect(f.dispatch("click").blocked).toBe(true);
    f.start();
    expect(f.dispatch("click")).toEqual({ prevented: false, blocked: false });
  });

  it("keeps its parent channel when authored scripts shadow parent or setTimeout", async () => {
    const f = bridgeFixture();
    // A design's top-level `const parent = …` / `let setTimeout = …` replaces these globals for later scripts.
    f.context.parent = { menu: true };
    f.context.setTimeout = () => { throw new Error("authored timer"); };
    f.dispatch("load");
    await flush();
    f.runTimers(120);
    expect(f.messages).toEqual([{ type: "sharpner:interaction-ready", token: options.token }]);
    f.start();
    expect(f.dispatch("click")).toEqual({ prevented: false, blocked: false });
  });

  it("bounds font readiness without relying on animation frames", async () => {
    const f = bridgeFixture(new Promise(() => {}));
    f.dispatch("load");
    f.runTimers(2000);
    await flush();
    f.runTimers(120);
    expect(f.messages).toEqual([{ type: "sharpner:interaction-ready", token: options.token }]);
  });

  it("captures Escape before authored keyboard handlers and exits only once", () => {
    const f = bridgeFixture();
    expect(f.dispatch("keydown", { key: "Escape" })).toEqual({ prevented: true, blocked: true });
    f.dispatch("beforeunload");
    f.dispatch("pagehide");
    expect(f.messages).toEqual([{ type: "sharpner:interaction-exit", token: options.token }]);
  });

  it("requests disposal on script navigation, including before the document is ready", () => {
    const f = bridgeFixture();
    f.dispatch("pagehide");
    expect(f.messages).toEqual([{ type: "sharpner:interaction-exit", token: options.token }]);
  });

  it("prevents anchor navigation while leaving local form handlers and validation available", async () => {
    const f = bridgeFixture();
    f.dispatch("load"); await flush(); f.runTimers(120); f.start();
    expect(f.dispatch("click", { composedPath: () => [new f.Element("https://example.com")] })).toEqual({ prevented: true, blocked: false });
    // Network form submissions are denied by form-action, after ordinary submit handlers run.
    expect(f.dispatch("submit")).toEqual({ prevented: false, blocked: false });
    f.dispatch("click", { composedPath: () => [new f.Element("#details%20panel")] });
    expect(f.scrolled).toEqual(["details panel"]);
  });
});

describe("interaction reply validation", () => {
  it("requires the current window and token and accepts no other message types", () => {
    const source = {} as Window;
    const data = { type: "sharpner:interaction-ready", token: options.token };
    expect(interactionReply({ source, data }, source, options.token)).toEqual(data);
    expect(interactionReply({ source: {} as Window, data }, source, options.token)).toBeNull();
    expect(interactionReply({ source, data }, source, "new-document-token")).toBeNull();
    expect(interactionReply({ source, data }, null, options.token)).toBeNull();
    expect(interactionReply({ source, data: { ...data, type: "sharpnerHeight" } }, source, options.token)).toBeNull();
    expect(interactionReply({ source, data: { ...data, type: "sharpner:interaction-exit" } }, source, options.token)).toMatchObject({ type: "sharpner:interaction-exit" });
  });
});
