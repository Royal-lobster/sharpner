import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { catalogFamilyLabels, catalogSectionIds, layoutRects, union } from "../shared/layout";
import type { CanvasNode, CommentThread, ServerMsg } from "../shared/types";
import { CanvasLayout } from "./canvas-layout";
import { Room } from "./room";

class Socket {
  static OPEN = 1;
  static current: Socket;
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  constructor() { Socket.current = this; }
  send() {}
  close() {}
  receive(message: ServerMsg) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

let room: Room;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.stubGlobal("location", { protocol: "https:", host: "sharpner.example" });
  vi.stubGlobal("WebSocket", Socket);
  room = new Room("stress");
});
afterEach(() => { room.close(); vi.useRealTimers(); vi.unstubAllGlobals(); });

const frame = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page", parentId: null, kind: "frame", name: id, x: 0, y: 0,
  width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const initialize = (nodes: CanvasNode[], comments: CommentThread[] = []) => Socket.current.receive({
  type: "init", nodes, comments, pages: [...new Set(nodes.map((node) => node.pageId))].map((id, sort) => ({ id, name: id, sort })),
  cid: "stress", peers: [], library: null,
});

// Opt-in: the normal suite keeps fast regression coverage; this workload uses one worker.
describe.skipIf(import.meta.env.MODE !== "stress")("canvas layout stress", () => {
  it("reuses a 50,000-node page and stays current through 2,500 server edits", () => {
    initialize(Array.from({ length: 50_000 }, (_, i) => frame(`screen-${i}`, { x: (i % 250) * 600, y: Math.floor(i / 250) * 800 })));
    const layout = new CanvasLayout(room), first = layout.page("page"), viewport = { w: 1440, h: 960 };
    const navigation = layout.navigation("page", viewport);
    const started = performance.now();
    for (let i = 0; i < 10_000; i++) {
      expect(layout.page("page")).toBe(first);
      expect(layout.navigation("page", viewport)).toBe(navigation);
    }
    console.info(JSON.stringify({ scenario: "50k nodes, 10k cached page/navigation reads", milliseconds: performance.now() - started }));
    for (let batch = 0; batch < 50; batch++) {
      const nodes = Array.from({ length: 50 }, (_, i) => {
        const id = `screen-${batch * 50 + i}`;
        return { ...room.nodes.get(id)!, x: -1000 - batch * 50 - i, width: 500 + i };
      });
      Socket.current.receive({ type: "sync", nodes, by: null });
      const next = layout.page("page");
      expect(next).not.toBe(first);
      expect(next.rects.size).toBe(50_000);
      for (const node of nodes) expect(next.rects.get(node.id)).toEqual({ x: node.x, y: node.y, w: node.width, h: 600 });
      expect(layout.page("page")).toBe(next);
    }
  }, 30_000);

  it("matches fresh shared layout through 1,000 mixed edits in nested sections", () => {
    const sections = Array.from({ length: 24 }, (_, i) => frame(`section-${i}`, {
      kind: "section", layout: i % 3 ? "auto" : "free", height: null,
      parentId: i < 4 ? null : `section-${i % 4}`, x: (i % 4) * 3000, y: Math.floor(i / 4) * 2000,
    }));
    initialize([...sections, ...Array.from({ length: 1000 }, (_, i) => frame(`screen-${i}`, { parentId: `section-${i % 24}`, order: i, x: i % 10 * 500, y: Math.floor(i / 10) * 700 }))]);
    const layout = new CanvasLayout(room);
    let seed = 0x51a7;
    const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
    for (let step = 0; step < 1000; step++) {
      const id = `screen-${random() % 1000}`;
      switch (step % 7) {
        case 0: room.moveLocal(new Map([[id, { x: random() % 5000 - 2500, y: random() % 5000 - 2500 }]])); break;
        case 1: room.send([{ t: "node.put", id, node: { width: 100 + random() % 900, height: 100 + random() % 1200 } }]); break;
        case 2: room.send([{ t: "node.put", id, node: { parentId: random() % 2 ? `section-${random() % 24}` : null, order: random() % 1000 } }]); break;
        case 3: room.send([{ t: "node.put", id, node: { height: null } }]); room.setHeight(id, 50 + random() % 1800); break;
        case 4: room.dragging.clear(); room.dragging.add(id); break;
        case 5: room.dragging.clear(); break;
        case 6: {
          const node = room.nodes.get(id)!;
          Socket.current.receive({ type: "sync", nodes: [{ ...node, rev: node.rev + 1, measuredHeight: 350 }], by: null });
          break;
        }
      }
      const actual = layout.page("page");
      expect(layout.page("page")).toBe(actual);
      // The existing uncached layout is an independent oracle for cache invalidation, not new geometry logic.
      if (step % 10 === 0 || step === 999) {
        const frames = room.pageNodes("page");
        const expected = layoutRects(frames, (node) => room.heightOf(node), room.dragging);
        const catalogs = catalogSectionIds(frames);
        expect(actual.rects).toEqual(expected);
        expect(actual.bounds).toEqual(union([...expected.values()]));
        expect(actual.catalogs).toEqual(catalogs);
        expect(actual.families).toEqual(catalogFamilyLabels(frames, expected, catalogs));
      }
    }
  }, 30_000);

  it("keeps navigation stable with 10,000 comments and follows resolution/deletion bursts", () => {
    const comments = Array.from({ length: 10_000 }, (_, i): CommentThread => ({
      id: `comment-${i}`, number: i + 1, anchor: { pageId: "page", nodeId: null, x: i, y: -i },
      firstMessage: { id: `message-${i}`, author: { id: "member", name: "Member", avatar: null }, body: "Feedback", createdAt: i },
      messageCount: 1, createdAt: i, updatedAt: i, resolvedAt: null, resolvedBy: null, revision: 1,
    }));
    initialize([frame("screen")], comments);
    const layout = new CanvasLayout(room), geometry = layout.page("page"), viewport = { w: 1440, h: 960 };
    const initial = layout.navigation("page", viewport);
    expect(initial.navigation.bounds).toEqual({ x: 0, y: -9999, w: 10_000, h: 10_599 });
    for (let i = 0; i < 10_000; i++) expect(layout.navigation("page", viewport)).toBe(initial);
    Socket.current.receive({ type: "comments", threads: comments.map((comment) => ({ ...comment, resolvedAt: 1, revision: 2 })) });
    expect(layout.page("page")).toBe(geometry);
    expect(layout.navigation("page", viewport).navigation.bounds).toEqual({ x: 0, y: 0, w: 400, h: 600 });
    expect(layout.navigation("page", viewport, "comment-9999").navigation.bounds).toEqual(initial.navigation.bounds);
    Socket.current.receive({ type: "comments", threads: [], deleted: comments.map((comment) => comment.id) });
    expect(layout.navigation("page", viewport, "comment-9999").navigationRects).toHaveLength(1);
    expect(layout.page("page")).toBe(geometry);
  }, 30_000);

  it("replaces geometry across 600 page visits and 20 reconnect snapshots", () => {
    const nodes = Array.from({ length: 20_000 }, (_, i) => frame(`screen-${i}`, { pageId: `page-${i % 200}`, x: i }));
    initialize(nodes);
    const layout = new CanvasLayout(room);
    for (let i = 0; i < 600; i++) {
      const page = `page-${i % 200}`, snapshot = layout.page(page);
      expect(snapshot.frames).toHaveLength(100);
      expect(snapshot.frames.every((node) => node.pageId === page)).toBe(true);
      expect(layout.page(page)).toBe(snapshot);
      layout.page(`page-${(i + 1) % 200}`);
      expect(layout.page(page)).not.toBe(snapshot);
    }
    for (let i = 0; i < 20; i++) {
      initialize([frame(`replacement-${i}`, { x: i * -1000, height: null, measuredHeight: i + 100 })]);
      const snapshot = layout.page("page");
      expect([...snapshot.rects.keys()]).toEqual([`replacement-${i}`]);
      expect(snapshot.bounds).toEqual({ x: i === 0 ? 0 : i * -1000, y: 0, w: 400, h: i + 100 });
    }
  }, 30_000);
});
