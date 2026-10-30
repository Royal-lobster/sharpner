import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiTokenGetter } from "./api";
import { Room } from "./room";
import { CanvasLayout } from "./canvas-layout";
import type { CanvasNode, ClientMsg, CommentThread, ServerMsg } from "../shared/types";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: ClientMsg[] = [];
  constructor(readonly url: string) { Socket.instances.push(this); }
  close() {}
  send(data: string) { this.sent.push(JSON.parse(data) as ClientMsg); }
  open() { this.readyState = Socket.OPEN; this.onopen?.(); }
  receive(message: ServerMsg) { this.onmessage?.({ data: JSON.stringify(message) }); }
  disconnect(code = 1006) { this.onclose?.({ code }); }
}

const fetcher = vi.fn<typeof fetch>();
let room: Room;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("location", { protocol: "https:", host: "sharpner.example" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset();
  setApiTokenGetter(async () => "session_fixture");
  room = new Room("file_fixture");
});
afterEach(() => {
  room.close();
  setApiTokenGetter(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("canvas reconnect authorization", () => {
  it.each([401, 403, 404])("stops reconnecting when the hidden upgrade failure is HTTP %s", async (status) => {
    fetcher.mockResolvedValue(Response.json({ error: "unavailable" }, { status }));
    Socket.instances[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(room.status).toBe("denied");
    expect(fetcher).toHaveBeenCalledWith("/api/files/file_fixture", expect.objectContaining({
      headers: expect.any(Headers),
    }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("gets current session credentials before reconnecting an expired socket", async () => {
    fetcher.mockResolvedValue(Response.json({}));
    Socket.instances[0]!.disconnect(4001);
    await vi.advanceTimersByTimeAsync(500);
    const headers = fetcher.mock.calls[0]![1]!.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer session_fixture");
    expect(Socket.instances).toHaveLength(2);
    expect(room.status).toBe("connecting");
  });

  it("backs off transient access-check failures without opening unauthenticated sockets", async () => {
    fetcher.mockResolvedValueOnce(Response.json({ error: "Clerk unavailable" }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({}));
    Socket.instances[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    expect(Socket.instances).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(Socket.instances).toHaveLength(2);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps an explicit access revocation terminal", async () => {
    Socket.instances[0]!.disconnect(4403);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(room.status).toBe("denied");
    expect(fetcher).not.toHaveBeenCalled();
    expect(Socket.instances).toHaveLength(1);
  });

  it("does not reconnect a disposed editor after its access check completes", async () => {
    let resolveResponse!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    Socket.instances[0]!.disconnect();
    await vi.advanceTimersByTimeAsync(500);
    const signal = fetcher.mock.calls[0]![1]!.signal;
    room.close();
    expect(signal?.aborted).toBe(true);
    resolveResponse(Response.json({}));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
  });
});

const node = (id: string, patch: Partial<CanvasNode> = {}): CanvasNode => ({
  id, pageId: "page_one", parentId: null, kind: "frame", name: id,
  x: 0, y: 0, width: 400, height: 600, measuredHeight: null,
  src: null, thumbLo: null, thumbHi: null, rev: 1, ...patch,
});
const start = (nodes: CanvasNode[], socket = Socket.instances.at(-1)!) => {
  socket.open();
  socket.receive({ type: "init", pages: [{ id: "page_one", name: "One", sort: 0 }, { id: "page_two", name: "Two", sort: 1 }], nodes, cid: "viewer", peers: [], library: null });
  return socket;
};
const sourceIds = (socket: Socket) => socket.sent.flatMap((message) => message.type === "source" ? message.ids : []);
const tick = () => vi.advanceTimersByTimeAsync(0);
const supply = (socket: Socket, id: string, source = `<p>${id}</p>`, rev = 1) => socket.receive({ type: "source", items: [{ id, source, rev }] });

describe("cached canvas layout", () => {
  const viewport = { w: 1440, h: 960 };
  const feedback: CommentThread = { id: "pin", number: 1, anchor: { pageId: "page_one", nodeId: null, x: 5000, y: -200 },
    firstMessage: { id: "message", author: { id: "alice", name: "Alice", avatar: null }, body: "Spacing", createdAt: 1 },
    messageCount: 1, createdAt: 1, updatedAt: 1, resolvedAt: null, resolvedBy: null, revision: 1 };

  it("reuses geometry and navigation through cursor, source and agent traffic", () => {
    const socket = start([node("screen")]);
    const layout = new CanvasLayout(room), geometry = layout.page("page_one"), view = layout.navigation("page_one", viewport);
    socket.receive({ type: "peer", peer: { id: "other", cid: "tab", name: "Other", avatar: null, pageId: "page_one", selection: [], cursor: { x: 10, y: 20 } } });
    supply(socket, "screen");
    socket.receive({ type: "activity", by: { id: "agent", name: "Agent", avatar: null }, ids: ["screen"] });
    socket.receive({ type: "library", library: { fileId: "library", name: "Library", design: { tokens: "", components: [] } } });
    expect(layout.page("page_one")).toBe(geometry);
    expect(layout.navigation("page_one", { ...viewport })).toBe(view);
    expect(geometry.rects.get("screen")).toEqual({ x: 0, y: 0, w: 400, h: 600 });
  });

  it("refreshes geometry after optimistic movement, resize, deletion and creation", () => {
    start([node("screen")]);
    const layout = new CanvasLayout(room), before = layout.page("page_one");
    room.moveLocal(new Map([["screen", { x: 80, y: 100 }]]));
    expect(layout.page("page_one")).not.toBe(before);
    expect(layout.page("page_one").rects.get("screen")).toEqual({ x: 80, y: 100, w: 400, h: 600 });
    room.send([{ t: "node.put", id: "screen", node: { width: 500, height: 700 } }]);
    expect(layout.page("page_one").rects.get("screen")).toEqual({ x: 80, y: 100, w: 500, h: 700 });
    room.send([{ t: "node.del", ids: ["screen"] }]);
    expect(layout.page("page_one").rects.size).toBe(0);
    room.send([{ t: "node.put", id: "replacement", node: { pageId: "page_one", x: -40, y: 20, width: 100, height: 200 } }]);
    expect(layout.page("page_one").rects.get("replacement")).toEqual({ x: -40, y: 20, w: 100, h: 200 });
  });

  it("keeps zoomed panning free while cached navigation still locks the fitted overview", () => {
    start([node("section", { kind: "section", x: 0, y: 0 }), node("screen", { width: 2000, height: 4000 })]);
    const layout = new CanvasLayout(room), view = layout.navigation("page_one", viewport);
    const requested = { x: 180, y: 160, z: 1 };
    expect(view.navigation.constrain(requested)).toEqual(requested);
    expect(layout.navigation("page_one", viewport)).toBe(view);
    expect(view.navigation.constrain({ x: 1e10, y: -1e10, z: view.navigation.minZoom })).toEqual(view.navigation.overview);
  });

  it("uses live heights and drops stale heights after a source revision or reconnect", () => {
    const frame = node("auto", { height: null, measuredHeight: 200 });
    const socket = start([frame]), layout = new CanvasLayout(room);
    room.setHeight("auto", 500);
    expect(layout.page("page_one").rects.get("auto")?.h).toBe(500);
    start([frame]);
    expect(layout.page("page_one").rects.get("auto")?.h).toBe(500);
    socket.receive({ type: "sync", nodes: [{ ...frame, rev: 2 }], by: null });
    expect(layout.page("page_one").rects.get("auto")?.h).toBe(200);
    room.setHeight("auto", 900);
    expect(layout.page("page_one").rects.get("auto")?.h).toBe(900);
    start([{ ...frame, rev: 3, measuredHeight: 300 }]);
    expect(layout.page("page_one").rects.get("auto")?.h).toBe(300);
  });

  it("invalidates when a drag starts or ends without a geometry revision", () => {
    start([node("group", { kind: "section", width: 480, height: null }), node("child", { parentId: "group", x: 200, y: 300, width: 100, height: 100 })]);
    const layout = new CanvasLayout(room), before = layout.page("page_one"), revision = room.dataRevision;
    expect(before.rects.get("group")).toEqual({ x: 72, y: 172, w: 356, h: 356 });
    room.dragging.add("child");
    const floating = layout.page("page_one");
    expect(floating.rects.get("group")).toEqual({ x: 0, y: 0, w: 480, h: 280 });
    room.dragging.clear();
    const dropped = layout.page("page_one");
    expect(dropped).not.toBe(floating);
    expect(dropped.rects.get("group")).toEqual(before.rects.get("group"));
    expect(room.dataRevision).toBe(revision);
  });

  it("compares exact drag membership even when serialized IDs would collide", () => {
    start([node("group", { kind: "section", height: null }), ...["a,b", "c", "a", "b,c"].map((id, i) => node(id, { parentId: "group", x: i * 1000 }))]);
    const layout = new CanvasLayout(room);
    room.dragging.add("a,b"); room.dragging.add("c");
    const first = layout.page("page_one");
    room.dragging.clear(); room.dragging.add("a"); room.dragging.add("b,c");
    const second = layout.page("page_one");
    expect(second).not.toBe(first);
    expect(second.rects.get("group")).not.toEqual(first.rects.get("group"));
  });

  it("refreshes catalog labels and partitions after component and section edits", () => {
    start([node("catalog", { kind: "section", layout: "auto", height: null }), node("button", { kind: "component", name: "Button/Primary", parentId: "catalog", width: 180, height: 40 })]);
    const layout = new CanvasLayout(room);
    expect(layout.page("page_one").catalogs.has("catalog")).toBe(true);
    expect(layout.page("page_one").families.map((label) => label.family)).toEqual(["Button"]);
    room.send([{ t: "node.put", id: "button", node: { name: "Input/Text" } }]);
    expect(layout.page("page_one").families.map((label) => label.family)).toEqual(["Input"]);
    room.send([{ t: "node.put", id: "button", node: { kind: "frame", parentId: null } }]);
    expect(layout.page("page_one").catalogs.size).toBe(0);
    expect(layout.page("page_one").families).toEqual([]);
    room.send([{ t: "node.put", id: "catalog", node: { kind: "frame", width: 200, height: 300 } }]);
    expect(layout.page("page_one").sections).toHaveLength(0);
    expect(layout.page("page_one").nodes).toHaveLength(2);
  });

  it("updates comment bounds independently and includes only the active resolved thread", () => {
    const socket = start([node("screen")]), layout = new CanvasLayout(room), geometry = layout.page("page_one");
    const original = layout.navigation("page_one", viewport);
    socket.receive({ type: "comments", threads: [feedback, { ...feedback, id: "other-page", anchor: { ...feedback.anchor, pageId: "page_two", x: 1e9 } }] });
    expect(layout.page("page_one")).toBe(geometry);
    expect(layout.navigation("page_one", viewport).navigation.bounds).toEqual({ x: 0, y: -200, w: 5001, h: 800 });
    socket.receive({ type: "comments", threads: [{ ...feedback, resolvedAt: 10, revision: 2 }] });
    expect(layout.navigation("page_one", viewport).navigation.bounds).toEqual(original.navigation.bounds);
    expect(layout.navigation("page_one", viewport, "pin").navigation.bounds).toEqual({ x: 0, y: -200, w: 5001, h: 800 });
    socket.receive({ type: "comments", threads: [], deleted: ["pin"] });
    expect(layout.navigation("page_one", viewport, "pin").navigation.bounds).toEqual(original.navigation.bounds);
  });

  it("follows node-relative pins and recomputes camera limits after viewport changes", () => {
    const socket = start([node("screen", { x: 100, y: 200 })]), layout = new CanvasLayout(room);
    socket.receive({ type: "comments", threads: [{ ...feedback, anchor: { pageId: "page_one", nodeId: "screen", x: 10, y: 20 } }] });
    expect(layout.navigation("page_one", viewport).navigationRects).toContainEqual({ x: 110, y: 220, w: 1, h: 1 });
    room.moveLocal(new Map([["screen", { x: 1000, y: -2000 }]]));
    expect(layout.navigation("page_one", viewport).navigationRects).toContainEqual({ x: 1010, y: -1980, w: 1, h: 1 });
    const geometry = layout.page("page_one"), wide = layout.navigation("page_one", viewport);
    const narrow = layout.navigation("page_one", { w: 390, h: 400 });
    expect(layout.page("page_one")).toBe(geometry);
    expect(narrow.navigation.minZoom).toBeLessThan(wide.navigation.minZoom);
  });

  it("invalidates navigation for HTTP comments and ignores stale realtime summaries", async () => {
    const socket = start([node("screen")]), layout = new CanvasLayout(room);
    const before = layout.navigation("page_one", viewport);
    fetcher.mockResolvedValue(Response.json({ ...feedback, messages: [feedback.firstMessage] }));
    await room.createComment(feedback.anchor, feedback.firstMessage.body);
    const posted = layout.navigation("page_one", viewport);
    expect(posted).not.toBe(before);
    expect(posted.navigation.bounds.w).toBe(5001);
    socket.receive({ type: "comments", threads: [{ ...feedback, revision: 3, resolvedAt: 20 }] });
    const resolved = layout.navigation("page_one", viewport);
    socket.receive({ type: "comments", threads: [{ ...feedback, revision: 2 }] });
    expect(layout.navigation("page_one", viewport)).toBe(resolved);
    socket.receive({ type: "comments", threads: [], deleted: ["pin"] });
    const deleted = layout.navigation("page_one", viewport);
    socket.receive({ type: "comments", threads: [feedback] });
    expect(layout.navigation("page_one", viewport)).toBe(deleted);
  });

  it("retains only the current page snapshot and refreshes page membership on reconnect", () => {
    const frame = node("screen"), socket = start([frame, node("other", { pageId: "page_two" })]), layout = new CanvasLayout(room);
    const first = layout.page("page_one");
    expect(layout.page("page_two").frames.map((n) => n.id)).toEqual(["other"]);
    expect(layout.page("page_one")).not.toBe(first);
    socket.receive({ type: "sync", nodes: [{ ...frame, pageId: "page_two" }], by: null });
    expect(layout.page("page_one").frames).toEqual([]);
    start([node("replacement", { x: -500 })]);
    expect(layout.page("page_one").frames.map((n) => n.id)).toEqual(["replacement"]);
    expect(layout.page("page_two").rects.size).toBe(0);
    expect(layout.navigation("page_two", viewport).navigationRects).toEqual([]);
    expect(layout.navigation("page_two", viewport).navigation.bounds).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe("live comments and people", () => {
  const thread: CommentThread = { id: "feedback", number: 1, anchor: { pageId: "page_one", nodeId: null, x: 10, y: 20 },
    firstMessage: { id: "message", author: { id: "alice", name: "Alice", avatar: null }, body: "Improve spacing", createdAt: 1 },
    messageCount: 1, createdAt: 1, updatedAt: 1, resolvedAt: null, resolvedBy: null, revision: 1 };

  it("syncs pins without invalidating layout or sources and clears stale people on disconnect", () => {
    const socket = start([node("screen")]);
    const revision = room.dataRevision, design = room.design();
    socket.receive({ type: "comments", threads: [thread] });
    socket.receive({ type: "peer", peer: { id: "bob", name: "Bob", avatar: null, cid: "bob-tab", pageId: "page_one", selection: [], cursor: null } });
    expect(room.comments.get(thread.id)).toEqual(thread);
    expect(room.peers.size).toBe(1);
    expect(room.dataRevision).toBe(revision);
    expect(room.design()).toBe(design);
    socket.disconnect();
    expect(room.peers.size).toBe(0);
    expect(room.comments.size).toBe(1);
  });

  it("does not undo newer agent feedback when an older HTTP reply arrives late", async () => {
    const socket = start([]);
    socket.receive({ type: "comments", threads: [thread] });
    let response!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>((resolve) => { response = resolve; }));
    const posting = room.replyComment(thread.id, "Thanks");
    await vi.advanceTimersByTimeAsync(0);
    const newer = { ...thread, revision: 3, resolvedAt: 40, messageCount: 3 };
    socket.receive({ type: "comments", threads: [newer] });
    response(Response.json({ ...thread, revision: 2, messageCount: 2, messages: [] }));
    await posting;
    expect(room.comments.get(thread.id)).toEqual(newer);
  });

  it("never resurrects a deleted thread from a late HTTP response", async () => {
    const socket = start([]);
    socket.receive({ type: "comments", threads: [thread] });
    let response!: (value: Response) => void;
    fetcher.mockReturnValue(new Promise<Response>((resolve) => { response = resolve; }));
    const posting = room.replyComment(thread.id, "Thanks");
    await vi.advanceTimersByTimeAsync(0);
    socket.receive({ type: "comments", threads: [], deleted: [thread.id] });
    response(Response.json({ ...thread, revision: 2, messages: [] }));
    await posting;
    expect(room.comments.has(thread.id)).toBe(false);
  });

  it("refreshes all thread metadata on reconnect and prevents public viewers from posting", async () => {
    const socket = start([]);
    socket.receive({ type: "comments", threads: [thread] });
    start([]);
    expect(room.comments.size).toBe(0);
    const viewer = new Room("file_fixture", "A".repeat(43));
    start([], Socket.instances.at(-1));
    await expect(viewer.createComment(thread.anchor, "Feedback")).rejects.toThrow("Reconnect");
    expect(fetcher).not.toHaveBeenCalled();
    viewer.close();
  });
});

describe("canvas source working set", () => {
  it("reuses matching cached revisions on reconnect without retransferring visited screens", async () => {
    const nodes = [node("first"), node("second", { pageId: "page_two" })];
    const socket = start(nodes);
    room.needSources(["first"]); await tick(); supply(socket, "first");
    room.needSources(["second"]); await tick(); supply(socket, "second");
    room.needSources(["first"]); await tick();
    fetcher.mockResolvedValue(Response.json({}));
    socket.disconnect(4001);
    await vi.advanceTimersByTimeAsync(500);
    const reconnected = start(nodes);
    await tick();
    expect(sourceIds(reconnected)).toEqual([]);
    expect(room.sources.get("first")?.rev).toBe(1);
    expect(fetcher).toHaveBeenCalledTimes(1); // Session/file access is still revalidated.
  });

  it("refreshes an already-visible screen when an agent changes its source revision", async () => {
    const frame = node("live");
    const socket = start([frame]);
    room.needSources([frame.id]); await tick(); supply(socket, frame.id);
    socket.sent = [];
    socket.receive({ type: "sync", nodes: [{ ...frame, rev: 2 }], by: null });
    await tick();
    expect(sourceIds(socket)).toEqual([frame.id]);
    supply(socket, frame.id, "<p>Edited by the agent</p>", 2);
    expect(room.sources.get(frame.id)).toEqual({ rev: 2, source: "<p>Edited by the agent</p>" });
  });

  it("does not refresh changed offscreen sources until they are needed again", async () => {
    const first = node("first"), second = node("second");
    const socket = start([first, second]);
    room.needSources([first.id]); await tick(); supply(socket, first.id);
    room.needSources([second.id]); await tick(); supply(socket, second.id);
    socket.sent = [];
    socket.receive({ type: "sync", nodes: [{ ...first, rev: 2 }], by: null });
    await tick();
    expect(sourceIds(socket)).toEqual([]);
    room.needSources([first.id]); await tick();
    expect(sourceIds(socket)).toEqual([first.id]);
  });

  it("drops stale in-flight responses and requests the current revision once", async () => {
    const frame = node("changing");
    const socket = start([frame]);
    room.needSources([frame.id]); room.needSources([frame.id]); await tick();
    expect(sourceIds(socket)).toEqual([frame.id]);
    socket.receive({ type: "sync", nodes: [{ ...frame, rev: 2 }], by: null });
    supply(socket, frame.id, "Old source", 1); await tick();
    expect(room.sources.get(frame.id)).toBeUndefined();
    expect(sourceIds(socket)).toEqual([frame.id, frame.id]);
    supply(socket, frame.id, "Current source", 2); await tick();
    expect(room.sources.get(frame.id)?.source).toBe("Current source");
    expect(sourceIds(socket)).toEqual([frame.id, frame.id]);
  });

  it("forgets deleted node data and ignores its late source response", async () => {
    const socket = start([node("kept"), node("deleted")]);
    room.needSources(["kept", "deleted"]); await tick();
    supply(socket, "kept"); supply(socket, "deleted");
    room.setHeight("deleted", 850);
    socket.receive({ type: "sync", nodeDels: ["deleted"], by: null });
    supply(socket, "deleted", "Late deleted source");
    expect(room.nodes.has("deleted")).toBe(false);
    expect(room.sources.has("deleted")).toBe(false);
    expect(room.heights.has("deleted")).toBe(false);
    expect(room.sources.has("kept")).toBe(true);
  });

  it.each(["remote", "local"] as const)("forgets all cached node data when a page is deleted %s", async (mode) => {
    const socket = start([node("kept"), node("removed", { pageId: "page_two" })]);
    room.needSources(["kept", "removed"]); await tick();
    supply(socket, "kept"); supply(socket, "removed"); room.setHeight("removed", 850);
    if (mode === "remote") socket.receive({ type: "sync", pageDels: ["page_two"], by: null });
    else room.send([{ t: "page.del", id: "page_two" }]);
    expect(room.nodes.has("removed")).toBe(false);
    expect(room.sources.has("removed")).toBe(false);
    expect(room.heights.has("removed")).toBe(false);
    expect(room.sources.has("kept")).toBe(true);
  });

  it("bounds visited screen HTML while preserving visible nodes and design definitions", async () => {
    const frames = Array.from({ length: 180 }, (_, index) => node(`screen_${index}`));
    const socket = start([...frames, node("tokens", { kind: "tokens" }), node("button", { kind: "component", name: "Button/Primary" })]);
    await tick(); supply(socket, "tokens", "@theme { --color-primary: green; }"); supply(socket, "button", "<button>Continue</button>");
    for (const frame of frames) {
      room.needSources([frame.id]); await tick(); supply(socket, frame.id);
    }
    const cachedFrames = [...room.sources.keys()].filter((id) => id.startsWith("screen_"));
    expect(cachedFrames.length).toBeLessThanOrEqual(128);
    expect(room.sources.has("screen_179")).toBe(true);
    expect(room.sources.has("screen_0")).toBe(false);
    expect(room.sources.has("tokens")).toBe(true);
    expect(room.sources.has("button")).toBe(true);
  });

  it("also bounds cached HTML by bytes instead of only entry count", async () => {
    const frames = Array.from({ length: 24 }, (_, index) => node(`large_${index}`));
    const socket = start(frames);
    const source = "x".repeat(256 * 1024);
    for (const frame of frames) {
      room.needSources([frame.id]); await tick(); supply(socket, frame.id, source);
    }
    expect([...room.sources.values()].reduce((bytes, item) => bytes + item.source.length * 2, 0)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(room.sources.has("large_23")).toBe(true);
  });

  it("limits outstanding source work and advances as responses arrive", async () => {
    const definitions = Array.from({ length: 40 }, (_, index) => node(`component_${index}`, { kind: "component", name: `Item/${index}` }));
    const socket = start(definitions);
    await tick();
    expect(sourceIds(socket)).toHaveLength(16);
    expect(socket.sent.filter((message) => message.type === "source").every((message) => message.ids.length <= 8)).toBe(true);
    supply(socket, "component_0", "<button>Zero</button>"); await tick();
    expect(sourceIds(socket)).toHaveLength(17);
    expect(new Set(sourceIds(socket)).size).toBe(17);
  });

  it("does not let messages from a retired socket overwrite current cached sources", async () => {
    const frame = node("current");
    const retired = start([frame]);
    room.needSources([frame.id]); await tick(); supply(retired, frame.id);
    fetcher.mockResolvedValue(Response.json({})); retired.disconnect(4001);
    await vi.advanceTimersByTimeAsync(500);
    const active = start([{ ...frame, rev: 2 }]); await tick(); supply(active, frame.id, "Current source", 2);
    supply(retired, frame.id, "Retired source", 1);
    expect(room.sources.get(frame.id)?.source).toBe("Current source");
  });

  it("keeps page/layout and design caches stable through peer cursor updates", async () => {
    const socket = start([node("screen"), node("button", { kind: "component", name: "Button/Primary" })]);
    await tick(); supply(socket, "button", "<button>Continue</button>");
    const page = room.pageNodes("page_one"), design = room.design(), revision = room.dataRevision;
    socket.receive({ type: "peer", peer: { id: "other", cid: "other_socket", name: "Other", avatar: null, pageId: "page_one", selection: [], cursor: { x: 10, y: 20 } } });
    expect(room.dataRevision).toBe(revision);
    expect(room.pageNodes("page_one")).toBe(page);
    expect(room.design()).toBe(design);
    room.moveLocal(new Map([["screen", { x: 80, y: 100 }]]));
    expect(room.dataRevision).toBeGreaterThan(revision);
    expect(room.pageNodes("page_one")).not.toBe(page);
    expect(room.pageNodes("page_one").find((item) => item.id === "screen")?.x).toBe(80);
    expect(room.design()).toBe(design);
  });

  it("invalidates design definitions when a component is renamed without a source revision", async () => {
    const component = node("button", { kind: "component", name: "Button/Primary" });
    const socket = start([component]); await tick(); supply(socket, "button", "<button>Continue</button>");
    const design = room.design();
    socket.receive({ type: "sync", nodes: [{ ...component, name: "Button/Secondary" }], by: null });
    expect(room.design()).not.toBe(design);
    expect(room.design().components.map((item) => item.tag)).toEqual(["x-button-secondary"]);
  });
});
