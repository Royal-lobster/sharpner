import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@cloudflare/puppeteer";
import { frameDocument } from "../shared/types";
import { hiScale, documentDesign, seedInput, tailwindCss } from "./render";
import { alignment, planSprites, renderSprite, SPRITE_LIMITS } from "./render-sprite";

describe("sprite documents", () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A page that runs the sprite's own page code against just enough DOM to record each frame's document. */
  function recordingPage() {
    const messages: number[] = [], srcdocs: string[] = [];
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      createElement: () => ({ dataset: {}, style: {}, remove() {} }),
      body: { appendChild(frame: { dataset: { i: string }; srcdoc: string; onload: () => void }) { srcdocs[Number(frame.dataset.i)] = frame.srcdoc; queueMicrotask(() => frame.onload()); } },
    });
    const page = {
      goto: async () => {}, setContent: async () => {},
      evaluate: async (fn: (args: unknown) => unknown, args: { parts?: string[]; sizes?: unknown[] }) => {
        messages.push(JSON.stringify(args ?? null).length);
        return args?.parts || args?.sizes ? fn(args) : { placed: [], fallback: [], width: 1, height: 1 };
      },
    } as unknown as Page;
    return { page, messages, srcdocs };
  }
  const whole = (jobs: { html: string }[], design: { tokens: string; components: { tag: string; html: string }[] }) => Promise.all(jobs.map(async (job) => {
    const scoped = documentDesign(job.html, design);
    const { cssSource, candidates } = seedInput(job.html, "https://sharpner.example", scoped);
    return frameDocument(job.html, { base: "https://sharpner.example", design: scoped, compiledTailwind: true, tailwindCss: await tailwindCss(cssSource, candidates) });
  }));

  it("sends what its documents share once, in bounded messages, and loads each document whole", async () => {
    // Two megabyte-sized definitions, as a playable prototype embeds, used by every frame; one used by a single frame.
    const data = (n: number) => `<script type="text/plain" data-chunk="${n}">${"QUJD".repeat(250_000)}</script>`;
    const design = {
      tokens: `@theme { --color-brand: #0f0; }\n${"/* token */".repeat(500)}`,
      components: [{ tag: "x-data-1", html: data(1) }, { tag: "x-data-2", html: data(2) }, { tag: "x-card", html: `<div class="p-4 bg-brand">${"card ".repeat(2000)}</div>` }, { tag: "x-unused", html: data(3) }],
    };
    const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, html: `<main class="p-${i % 8}"><x-data-1></x-data-1><x-data-2></x-data-2>${i === 3 ? "<x-card></x-card>" : ""}</main>`, width: 390, height: null }));
    const { page, messages, srcdocs } = recordingPage();
    await renderSprite(page, jobs, "https://sharpner.example", design);
    const expected = await whole(jobs, design);
    // Each document is 2 MB, so the twelve hold 24 MB; what they share is 2 MB.
    expect(expected.every((doc) => doc.length > 2_000_000)).toBe(true);
    expect(messages.reduce((a, b) => a + b, 0)).toBeLessThan(2_300_000);
    expect(Math.max(...messages)).toBeLessThanOrEqual(SPRITE_LIMITS.batchChars * 1.1);
    expect(srcdocs.length).toBe(expected.length);
    srcdocs.forEach((doc, i) => expect(doc === expected[i]).toBe(true));
  });

  it("splits documents that share nothing into bounded messages", async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, html: `<main>${`body ${i} `.repeat(60_000)}</main>`, width: 390, height: null }));
    const design = { tokens: "", components: [] };
    const { page, messages, srcdocs } = recordingPage();
    await renderSprite(page, jobs, "https://sharpner.example", design);
    const expected = await whole(jobs, design);
    expect(expected.reduce((a, doc) => a + doc.length, 0)).toBeGreaterThan(5_000_000);
    expect(Math.max(...messages)).toBeLessThanOrEqual(SPRITE_LIMITS.batchChars * 1.1);
    expect(srcdocs.length).toBe(expected.length);
    srcdocs.forEach((doc, i) => expect(doc === expected[i]).toBe(true));
  });

  it("keeps a document whole when its own text looks like shared content", async () => {
    // The frame's HTML repeats a component definition's text and the token sheet before the places they are shared from.
    const card = `<div class="p-4">${"card ".repeat(400)}</div>`, tokens = `@theme { --color-brand: #0f0; }${"/* token */".repeat(200)}`;
    const design = { tokens, components: [{ tag: "x-card", html: card }] };
    const jobs = [0, 1].map((i) => ({ id: `n${i}`, html: `<main><pre>${JSON.stringify(card)}</pre><style type="text/tailwindcss">${tokens}</style><x-card></x-card>@@sharpner-part-0@@</main>`, width: 390, height: null }));
    const { page, srcdocs } = recordingPage();
    await renderSprite(page, jobs, "https://sharpner.example", design);
    const expected = await whole(jobs, design);
    expect(srcdocs.length).toBe(expected.length);
    srcdocs.forEach((doc, i) => expect(doc === expected[i]).toBe(true));
  });
});

const node = (id: string, width = 400, height: number | null = null, measuredHeight: number | null = null) => ({ id, width, height, measuredHeight });
const ids = (sprites: { id: string }[][]) => sprites.map((s) => s.map((n) => n.id));

describe("sprite planning", () => {
  it("shares the batch across tabs in order, so the first nodes render first", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => node(`n${i}`));
    expect(ids(planSprites(jobs, 4))).toEqual([["n0", "n1", "n2"], ["n3", "n4", "n5"], ["n6", "n7", "n8"], ["n9"]]);
    expect(planSprites([], 4)).toEqual([]);
  });

  it("caps each sprite by node count and by the area it is expected to cover", () => {
    const many = Array.from({ length: 30 }, (_, i) => node(`n${i}`));
    expect(planSprites(many, 1, { nodes: 12, pixels: Infinity }).map((s) => s.length)).toEqual([12, 12, 6]);
    // A known measured height counts; without one, an auto-height node is planned at its first 800px layout.
    const tall = [node("a", 1000, null, 3000), node("b", 1000, null, 3000), node("c", 1000), node("d", 1000, 500)];
    expect(ids(planSprites(tall, 1, { nodes: 24, pixels: 6_500_000 }))).toEqual([["a", "b"], ["c", "d"]]);
  });

  it("caps each sprite by the weight of its documents, so megabyte documents are not loaded together", () => {
    const light = (id: string) => ({ ...node(id), weight: 200_000 }), heavy = (id: string) => ({ ...node(id), weight: 4_300_000 });
    // As planned before weights: five megabyte documents to a sprite.
    expect(ids(planSprites([heavy("a"), heavy("b"), heavy("c"), heavy("d"), heavy("e")], 1, { nodes: 24, pixels: Infinity }))).toEqual([["a", "b", "c", "d", "e"]]);
    expect(ids(planSprites([heavy("a"), heavy("b"), light("c"), light("d"), heavy("e")], 1))).toEqual([["a"], ["b", "c", "d"], ["e"]]);
    // Ordinary documents still fill a sprite.
    expect(planSprites(Array.from({ length: 30 }, (_, i) => light(`n${i}`)), 1).map((s) => s.length)).toEqual([24, 6]);
  });

  it("puts frames wider than the sharp tier in sprites of their own width, captured at one scale", () => {
    const jobs = [node("phone", 390), node("desk", 1440), node("card", 400), node("wide", 1920), node("desk2", 1440)];
    const sprites = planSprites(jobs, 1);
    expect(ids(sprites)).toEqual([["phone", "card"], ["desk", "desk2"], ["wide"]]);
    for (const sprite of sprites) expect(new Set(sprite.map((n) => hiScale(n.width))).size).toBe(1);
  });

  it("aligns offsets so a scaled crop starts on a whole pixel", () => {
    expect([400, 1280, 1440, 1920, 2560].map(alignment)).toEqual([1, 1, 9, 3, 2]);
    for (let width = 1281; width <= 3000; width++) {
      const step = alignment(width) * hiScale(width);
      expect(Math.abs(step - Math.round(step))).toBeLessThan(1e-9);
    }
  });
});
