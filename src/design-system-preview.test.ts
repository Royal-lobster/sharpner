// @vitest-environment happy-dom
import type { Window as TestWindow } from "happy-dom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyBrand, type CanvasNode, type DesignSystem } from "../shared/types";
import { DesignSystemPage } from "./DesignSystemPage";
import type { Room } from "./room";

class Visibility {
  static observers = new Set<Visibility>();
  elements = new Set<Element>();
  constructor(readonly callback: IntersectionObserverCallback) { Visibility.observers.add(this); }
  observe = (element: Element) => this.elements.add(element);
  unobserve = (element: Element) => this.elements.delete(element);
  disconnect = () => { this.elements.clear(); Visibility.observers.delete(this); };
  static show(visible: boolean) {
    for (const observer of [...this.observers]) observer.callback([...observer.elements].map(target => ({ target, isIntersecting: visible }) as IntersectionObserverEntry), observer as unknown as IntersectionObserver);
  }
}
let host: HTMLDivElement, root: Root;
const design: DesignSystem = { tokens: '@theme { --color-background: white; --color-foreground: black; --color-primary: blue; } .dark { --color-background: black; --color-foreground: white; }', components: Array.from({ length: 150 }, (_, i) => ({ tag: `x-control-${i}-default`, html: '<button class="w-[600px]">Full control</button>' })) };
const room = {
  library: null, nodes: new Map([["tokens", { id: "tokens", kind: "tokens", pageId: "ds" } as CanvasNode], ...design.components.map((c, i) => [String(i), { id: String(i), kind: "component", pageId: "ds", name: `Control ${i}/Default`, width: 600, height: null, thumbHi: `/saved-${i}.webp` } as CanvasNode] as const)]), sources: new Map([["tokens", { source: design.tokens }]]), pages: [], brand: emptyBrand(), fileTheme: "light", status: "open", dataRevision: 1, sourceRevision: 1, design: () => design,
} as unknown as Room;
const render = async () => { await act(async () => root.render(createElement(DesignSystemPage, { room, fileId: "file", fileName: "Test", pageId: "ds", readOnly: true }))); };
const click = async (selector: string) => { const button = host.querySelector<HTMLElement>(selector); expect(button, selector).not.toBeNull(); await act(async () => button!.click()); };
beforeEach(() => {
  (window as unknown as TestWindow).happyDOM.settings.handleDisabledFileLoadingAsSuccess = true;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("IntersectionObserver", Visibility);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); Visibility.observers.clear(); vi.unstubAllGlobals(); });

it("keeps file theme variables off the Sharpner document shell", async () => {
  await render();
  expect(host.querySelector<HTMLElement>(".ds-document")!.style.getPropertyValue("--color-background")).toBe("");
  await click('[aria-label="Preview theme"] button:last-child');
  expect(host.querySelector<HTMLElement>(".ds-document")!.style.getPropertyValue("--color-foreground")).toBe("");
});

it("browses hundreds of saved previews without mounting or swapping live iframes on scroll", async () => {
  await render();
  expect(host.querySelectorAll(".ds-preview img")).toHaveLength(150);
  for (const visible of [true, false, true]) await act(async () => Visibility.show(visible));
  expect(host.querySelectorAll("iframe")).toHaveLength(0);
  expect(host.querySelectorAll(".ds-preview img")).toHaveLength(150);
});

it("opens one inline interactive preview at a time and closes it explicitly", async () => {
  await render();
  await click('[aria-label="Interact with Control 0/Default"]');
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
  expect(host.querySelector("iframe")!.title).toBe("Control 0/Default interactive preview");
  await click('[aria-label="Interact with Control 1/Default"]');
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
  expect(host.querySelector("iframe")!.title).toBe("Control 1/Default interactive preview");
  await click('[aria-label="Close Control 1/Default preview"]');
  expect(host.querySelectorAll("iframe")).toHaveLength(0);
});

it("retains the saved image until ready, sizes to full content and pauses off screen without restarting on scroll", async () => {
  await render(); await click('[aria-label="Interact with Control 0/Default"]');
  const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
  expect(host.querySelector('[data-preview-id="file:0"] img')).not.toBeNull();
  // A real frame posts its measured content, rather than fitting into a 112px-high crop.
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { sharpnerPreview: { session: frame.dataset.previewSession, width: 900, height: 800 } } })));
  const preview = host.querySelector<HTMLElement>('[data-preview-id="file:0"]')!;
  expect(parseFloat(preview.style.height)).toBeGreaterThan(480);
  const height = preview.style.height;
  await act(async () => Visibility.show(true));
  await act(async () => Visibility.show(false));
  expect(host.querySelectorAll("iframe")).toHaveLength(0);
  expect(preview.style.height).toBe(height);
  await act(async () => Visibility.show(true));
  expect(host.querySelectorAll("iframe")).toHaveLength(0);
  await click('[aria-label="Interact with Control 0/Default"]');
  expect(host.querySelectorAll("iframe")).toHaveLength(1);
});

it("switches only the interactive document and ignores measurements from the previous theme", async () => {
  await render(); await click('[aria-label="Interact with Control 0/Default"]');
  const frame = host.querySelector<HTMLIFrameElement>("iframe")!;
  const previous = frame.dataset.previewSession;
  const html = frame.srcdoc;
  await click('[aria-label="Preview theme"] button:last-child');
  expect(host.querySelector("iframe")).toBe(frame);
  expect(frame.srcdoc).not.toBe(html);
  expect(frame.dataset.previewSession).not.toBe(previous);
  await act(async () => window.dispatchEvent(new MessageEvent("message", { source: frame.contentWindow, data: { sharpnerPreview: { session: previous, width: 900, height: 800 } } })));
  expect(frame.style.opacity).toBe("0");
  expect(host.querySelector('[data-preview-id="file:0"] img')).not.toBeNull();
  expect(host.querySelector("[role=status]")!.textContent).toContain("Dark");
});
