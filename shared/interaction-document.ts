import { frameDocument, type DesignSystem } from "./types";

// Form events and validation remain usable; form-action blocks their network/navigation default.
export const INTERACTION_SANDBOX = "allow-scripts allow-forms";
export const INTERACTION_READY_TIMEOUT_MS = 12_000;
export type InteractionReply = { type: "sharpner:interaction-ready" | "sharpner:interaction-exit"; token: string };

/** A channel scopes playback messages; the opaque frame origin cannot be used as an identity. */
export function interactionReply(event: Pick<MessageEvent, "source" | "data">, source: MessageEventSource | null, token: string): InteractionReply | null {
  const data = event.data as Partial<InteractionReply> | null;
  if (!source || event.source !== source || !data || data.token !== token) return null;
  return data.type === "sharpner:interaction-ready" || data.type === "sharpner:interaction-exit" ? data as InteractionReply : null;
}

/** Runs before authored code, inside the opaque playback document only. */
function interactionBridge(token: string) {
  let enabled = false;
  let announced = false;
  let exited = false;
  const post = (type: InteractionReply["type"]) => parent.postMessage({ type, token }, "*");
  const exit = () => { if (!exited) { exited = true; enabled = false; post("sharpner:interaction-exit"); } };
  const block = (event: Event) => { event.preventDefault(); event.stopImmediatePropagation(); };
  addEventListener("keydown", (event) => {
    if (event.key === "Escape") { block(event); exit(); }
    else if (!enabled && event.isTrusted) block(event);
  }, true);
  // Until the parent has revealed this exact document and acknowledged readiness, trusted input
  // cannot reach authored handlers. Programmatic setup events remain available to authored code.
  for (const name of ["keyup", "keypress", "pointerdown", "pointerup", "pointermove", "click", "dblclick", "auxclick", "contextmenu", "mousedown", "mouseup", "touchstart", "touchmove", "touchend", "wheel", "beforeinput", "input", "compositionstart", "compositionupdate", "compositionend"]) {
    addEventListener(name, (event) => { if (!enabled && event.isTrusted) block(event); }, { capture: true, passive: false });
  }
  addEventListener("message", (event) => {
    if (event.source === parent && event.data?.type === "sharpner:interaction-start" && event.data.token === token && announced && !exited) enabled = true;
  });
  addEventListener("click", (event) => {
    const anchor = event.composedPath().find((target): target is HTMLAnchorElement | HTMLAreaElement => target instanceof Element && target.matches("a[href],area[href]"));
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") ?? "";
    // A fragment remains useful for local UI without navigating the srcdoc to its asset base URL.
    if (href.startsWith("#") && href.length > 1) {
      try { document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView(); } catch { /* A malformed fragment is still prevented from navigating. */ }
    }
  }, true);
  // These observers request disposal; they do not prevent a script's navigation request itself.
  addEventListener("beforeunload", exit);
  addEventListener("pagehide", exit);
  addEventListener("load", () => {
    const fonts = document.fonts?.ready ?? Promise.resolve();
    const deadline = new Promise<void>((resolve) => setTimeout(resolve, 2000));
    void Promise.race([fonts, deadline]).catch(() => {}).then(() => setTimeout(() => {
      if (exited) return;
      announced = true;
      post("sharpner:interaction-ready");
    }, 120));
  }, { once: true });
}

const attribute = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * Playback uses the normal renderer, with a policy and bridge parsed before every authored byte.
 * Resource display remains network-capable; this is not an offline or total-network-isolation mode.
 */
export function interactionDocument(html: string, options: { base: string; token: string; design: DesignSystem; theme?: string | null }): string {
  const base = new URL(options.base);
  if (base.protocol !== "https:" && base.protocol !== "http:") throw new Error("Playback requires an HTTP(S) asset origin");
  const origin = base.origin;
  const policy = [
    "default-src 'none'",
    "script-src 'unsafe-inline' https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4.3.3",
    `style-src 'unsafe-inline' https: ${origin}`,
    `img-src data: blob: https: ${origin}`,
    `font-src data: blob: https: ${origin}`,
    "connect-src 'none'", "form-action 'none'", "base-uri 'none'",
    "frame-src 'none'", "object-src 'none'", "worker-src 'none'", "media-src 'none'",
  ].join("; ");
  const token = JSON.stringify(options.token).replace(/</g, "\\u003c");
  // The first base is trusted and frozen before base-uri is enforced. Later author bases cannot
  // select another asset origin. An additional authored CSP can tighten, never relax, this policy.
  // Leave the implicit head open: the normal document's html/body attributes are still parsed.
  const prefix = `<!doctype html><base href="${attribute(origin + "/")}" target="_self"><meta http-equiv="Content-Security-Policy" content="${attribute(policy)}"><script data-sharpner-playback-bridge>(${interactionBridge.toString()})(${token})</script>`;
  return prefix + frameDocument(html, { design: options.design, theme: options.theme });
}
