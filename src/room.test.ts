import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setApiTokenGetter } from "./api";
import { Room } from "./room";
import type { CanvasNode, ClientMsg, ServerMsg } from "../shared/types";

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
