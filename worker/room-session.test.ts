import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, Presence, ServerMsg } from "../shared/types";
import { ViewerAccess } from "./viewer-access";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { FileRoom } from "./room";

const issuer = "https://clerk.sharpner.example";
const previousIssuer = "https://sharpner-test.clerk.accounts.dev";
const publishableKey = `pk_live_${btoa("clerk.sharpner.example$")}`;
const member: Actor = { id: "local-member", name: "Member", avatar: null };
const token = "A".repeat(43);
type Lease = {
  cid: string; fileId: string; origin: string; actor: Actor; presence: Presence;
  sessionExpiresAt: number; sessionIssuer?: string; sessionId?: string; shareToken?: string;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-30T08:00:00Z"));
  vi.stubGlobal("WebSocket", { OPEN: 1 });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function socket(patch: Partial<Lease> = {}) {
  let attachment: Lease = {
    cid: "member", fileId: "file", origin: "https://sharpner.example", actor: member,
    presence: { pageId: null, selection: [], cursor: null },
    sessionExpiresAt: Date.now() + 60_000, sessionIssuer: issuer, sessionId: "session-member", ...patch,
  };
  const ws = {
    readyState: 1,
    deserializeAttachment: () => attachment,
    serializeAttachment: vi.fn((next: Lease) => { attachment = next; }),
    send: vi.fn(),
    close: vi.fn(),
  };
  ws.close.mockImplementation(() => { ws.readyState = 2; });
  return ws;
}

function fixture(...sockets: ReturnType<typeof socket>[]) {
  // Exercise the real socket methods, without SQLite writes or a thumbnail browser.
  const room = Object.create(FileRoom.prototype) as FileRoom;
  const lookup = vi.fn(async () => ({ id: "file", workspace_id: "workspace" }));
  const apply = vi.fn(async () => {});
  const node = vi.fn((id: string) => ({ id, rev: 1, source: "<p>Saved design</p>" }));
  const acceptWebSocket = vi.fn((ws: ReturnType<typeof socket>) => sockets.push(ws));
  Object.assign(room, {
    ctx: { getWebSockets: () => sockets, acceptWebSocket },
    env: { CLERK_PUBLISHABLE_KEY: publishableKey, DB: { prepare: () => ({ bind: () => ({ first: lookup }) }) } },
    viewerAccess: new ViewerAccess(),
    apply, node,
    libraryInfo: vi.fn(async () => null),
    pages: () => [], nodes: () => [], comments: () => [], meta: () => null, setMeta: vi.fn(),
  });
  const broadcast = (msg: ServerMsg) => (room as unknown as { broadcast(msg: ServerMsg): void }).broadcast(msg);
  return { room, lookup, apply, node, acceptWebSocket, broadcast };
}

describe("FileRoom member session issuer", () => {
  it("renews only the authenticated member's matching session and keeps it live past the old expiry", () => {
    const ws = socket();
    const { room, broadcast } = fixture(ws);
    vi.advanceTimersByTime(45_000);
    const expiresAt = Date.now() + 60_000;
    expect(room.renewSession("file", "member", member.id, "session-member", expiresAt)).toEqual({ expiresAt });
    vi.advanceTimersByTime(30_000);
    broadcast({ type: "sync", nodes: [], by: null });
    expect(ws.send).toHaveBeenCalledTimes(1);
    expect(ws.close).not.toHaveBeenCalled();
    expect(ws.deserializeAttachment().sessionExpiresAt).toBe(expiresAt);
  });

  it.each([
    { actorId: "other" }, { fileId: "other" }, { cid: "other" }, { sessionId: "other-session" },
    { sessionIssuer: previousIssuer }, { shareToken: token }, { sessionId: undefined },
  ])("does not renew a different, legacy or anonymous socket: %j", (patch) => {
    const ws = socket(patch);
    const { room } = fixture(ws);
    expect(room.renewSession("file", "member", patch.actorId ?? member.id, "session-member", Date.now() + 120_000)).toBeNull();
    expect(ws.deserializeAttachment().sessionExpiresAt).toBe(Date.now() + 60_000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("never grants a lease from invalid expiry %s", (expiresAt) => {
    const ws = socket();
    const { room } = fixture(ws);
    expect(room.renewSession("file", "member", member.id, "session-member", expiresAt)).toBeNull();
    expect(ws.serializeAttachment).not.toHaveBeenCalled();
  });

  it("does not allow presence payloads to impersonate another member in the avatar stack", async () => {
    const ws = socket();
    const { room } = fixture(ws);
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "presence", presence: {
      pageId: "screens", selection: [], cursor: null, id: "forged", name: "Someone else", avatar: "https://example.test/forged", agent: true,
    } }));
    expect(room.peers()).toEqual([{ ...member, cid: "member", pageId: "screens", selection: [], cursor: null }]);
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "presence", presence: { pageId: "screens", selection: [], cursor: { x: "invalid", y: 4 } } }));
    expect(room.peers()[0]!.cursor).toBeNull();
  });

  it("stamps the configured issuer at upgrade, ignoring a forged request header", async () => {
    const server = socket();
    const { room, acceptWebSocket } = fixture();
    vi.stubGlobal("WebSocketPair", class { 0 = {}; 1 = server; });
    // Node's Response does not implement Workers' 101 + webSocket response extension.
    vi.stubGlobal("Response", class { constructor(_body: unknown, readonly init: { status: number }) {} });
    await room.fetch(new Request("https://sharpner.example/ws", { headers: {
      upgrade: "websocket", "x-file": "file", "x-origin": "https://sharpner.example",
      "x-actor": JSON.stringify(member), "x-session-expiry": String(Date.now() + 60_000),
      "x-session-issuer": "https://forged.example",
      "x-session-id": "session-member",
      "x-session-principal": JSON.stringify({ clerkUserId: "clerk-member", sessionId: "session-member", organizationId: "clerk-workspace" }),
    } }));
    expect(acceptWebSocket).toHaveBeenCalledWith(server);
    expect(server.deserializeAttachment().sessionIssuer).toBe(issuer);
    expect(JSON.parse(server.send.mock.calls[0]![0]).type).toBe("init");
    expect(JSON.parse(server.send.mock.calls[0]![0]).principal).toEqual({ clerkUserId: "clerk-member", sessionId: "session-member", organizationId: "clerk-workspace" });
    expect(server.deserializeAttachment().actor.id).toBe("local-member");
    expect(server.close).not.toHaveBeenCalled();
  });

  it("keeps current-instance members eligible to write, read and appear as peers", async () => {
    const ws = socket();
    const { room, apply } = fixture(ws);
    const ops = [{ t: "page.put", page: { id: "page", name: "Page", sort: 0 } }];
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ops", ops }));
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "source", ids: ["node"] }));
    expect(apply).toHaveBeenCalledWith("file", "https://sharpner.example", ops, member);
    expect(JSON.parse(ws.send.mock.calls[0]![0])).toEqual({ type: "source", items: [{ id: "node", rev: 1, source: "<p>Saved design</p>" }] });
    expect(room.peers()).toEqual([{ ...member, pageId: null, selection: [], cursor: null, cid: "member" }]);
    expect(ws.close).not.toHaveBeenCalled();
  });

  it.each([undefined, previousIssuer])("rejects a hibernated member lease with issuer %s before reading or writing", async (sessionIssuer) => {
    const ws = socket({ sessionIssuer });
    const { room, apply, node, lookup } = fixture(ws);
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "source", ids: ["private-node"] }));
    await room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "ops", ops: [] }));
    expect(ws.close).toHaveBeenCalledWith(4001, expect.stringContaining("configuration changed"));
    expect(ws.send).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(node).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("excludes old-instance and legacy members from outbound messages and peer listings", () => {
    const old = socket({ cid: "old", sessionIssuer: previousIssuer });
    const legacy = socket({ cid: "legacy", sessionIssuer: undefined });
    const current = socket();
    const { room, broadcast } = fixture(old, legacy, current);
    broadcast({ type: "sync", nodeDels: ["node"], by: member });
    expect(old.send).not.toHaveBeenCalled();
    expect(legacy.send).not.toHaveBeenCalled();
    expect(current.send).toHaveBeenCalledTimes(1);
    expect(old.close).toHaveBeenCalledWith(4001, expect.any(String));
    expect(legacy.close).toHaveBeenCalledWith(4001, expect.any(String));

    // A fresh hibernation snapshot must also be filtered before any broadcast happened.
    const peerOnly = fixture(socket({ cid: "old", sessionIssuer: previousIssuer }), socket({ cid: "legacy", sessionIssuer: undefined }), current);
    expect(peerOnly.room.peers().map((peer) => peer.cid)).toEqual(["member"]);
  });

  it("still rejects expired current-instance members", () => {
    const expired = socket({ sessionExpiresAt: Date.now() });
    const { room, broadcast } = fixture(expired);
    broadcast({ type: "sync", nodes: [], by: null });
    expect(expired.send).not.toHaveBeenCalled();
    expect(expired.close).toHaveBeenCalledWith(4001, expect.stringContaining("expired"));
    expect(room.peers()).toEqual([]);
  });

  it("preserves anonymous viewers without an issuer, including source reads and member privacy", async () => {
    const viewer = socket({ cid: "viewer", shareToken: token, sessionIssuer: undefined });
    const { room, broadcast } = fixture(viewer);
    await room.webSocketMessage(viewer as unknown as WebSocket, JSON.stringify({ type: "source", ids: ["node"] }));
    expect(JSON.parse(viewer.send.mock.calls[0]![0]).type).toBe("source");
    broadcast({ type: "sync", nodeDels: ["node"], by: member });
    expect(JSON.parse(viewer.send.mock.calls[1]![0])).toEqual({ type: "sync", nodeDels: ["node"], by: null });
    broadcast({ type: "activity", ids: ["node"], by: { ...member, agent: true } });
    expect(viewer.send).toHaveBeenCalledTimes(2);
    expect(room.peers()).toEqual([]);
    expect(viewer.close).not.toHaveBeenCalled();
  });
});
