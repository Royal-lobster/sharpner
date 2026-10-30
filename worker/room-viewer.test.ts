import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, ServerMsg } from "../shared/types";
import { ViewerAccess } from "./viewer-access";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import { FileRoom } from "./room";

const member: Actor = { id: "private-member", name: "Private name", avatar: "https://example.test/private-photo" };
const token = "A".repeat(43);

beforeEach(() => vi.stubGlobal("WebSocket", { OPEN: 1 }));
afterEach(() => vi.unstubAllGlobals());

function socket(viewing: boolean) {
  const attachment = {
    cid: viewing ? "viewer" : "member", fileId: "file", origin: "https://example.test", actor: member,
    presence: { pageId: null, selection: [], cursor: null }, sessionExpiresAt: Date.now() + 60_000,
    ...(viewing ? { shareToken: token } : {}),
  };
  const ws = { readyState: 1, deserializeAttachment: () => attachment, send: vi.fn(), close: vi.fn() };
  ws.close.mockImplementation(() => { ws.readyState = 2; });
  return ws;
}

function fixture(lookup = vi.fn<() => Promise<unknown>>(async () => ({ shared: true }))) {
  // Keep the production websocket methods; these tests need no node storage or thumbnail browser.
  const room = Object.create(FileRoom.prototype) as FileRoom;
  const viewers = [socket(true), socket(false)];
  const apply = vi.fn();
  Object.assign(room, {
    ctx: { getWebSockets: () => viewers },
    env: { DB: { prepare: () => ({ bind: () => ({ first: lookup }) }) } },
    viewerAccess: new ViewerAccess(), apply,
  });
  const broadcast = (message: ServerMsg) => (room as unknown as { broadcast(message: ServerMsg): void }).broadcast(message);
  return { room, viewers, apply, lookup, broadcast };
}

describe("FileRoom public link boundary", () => {
  it("ignores forged edits and presence from a viewer before any write or broadcast", async () => {
    const { room, viewers, apply, lookup } = fixture();
    await room.webSocketMessage(viewers[0] as unknown as WebSocket, JSON.stringify({ type: "ops", ops: [{ t: "node.del", ids: ["important-node"] }] }));
    await room.webSocketMessage(viewers[0] as unknown as WebSocket, JSON.stringify({ type: "presence", presence: { pageId: "page", selection: ["node"], cursor: { x: 1, y: 2 } } }));
    expect(apply).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
    expect(viewers[1]!.send).not.toHaveBeenCalled();
  });

  it("sends edits to both audiences but reserves author and activity metadata for members", () => {
    const { viewers, broadcast } = fixture();
    broadcast({ type: "sync", nodeDels: ["node"], by: member });
    expect(JSON.parse(viewers[0]!.send.mock.calls[0]![0])).toEqual({ type: "sync", nodeDels: ["node"], by: null });
    expect(JSON.parse(viewers[1]!.send.mock.calls[0]![0]).by).toEqual(member);
    broadcast({ type: "activity", ids: ["node"], by: { ...member, agent: true } });
    expect(viewers[0]!.send).toHaveBeenCalledTimes(1);
    expect(viewers[1]!.send).toHaveBeenCalledTimes(2);
  });

  it("rejects an upgrade whose token check raced completed revocation", async () => {
    let finish!: (row: unknown) => void;
    const lookup = vi.fn(() => new Promise((resolve) => { finish = resolve; }));
    const { room, viewers } = fixture(lookup);
    const pair = vi.fn();
    vi.stubGlobal("WebSocketPair", pair);
    const pending = room.fetch(new Request("https://example.test/ws", { headers: {
      upgrade: "websocket", "x-share-token": token, "x-file": "file", "x-session-expiry": String(Date.now() + 60_000),
    } }));
    room.revokeViewers();
    finish({ shared: true });
    expect((await pending).status).toBe(403);
    expect(pair).not.toHaveBeenCalled();
    expect(viewers[0]!.close).toHaveBeenCalledWith(4403, expect.any(String));
    expect(viewers[1]!.close).not.toHaveBeenCalled();
  });

  it("does not send subsequent changes to a revoked viewer", () => {
    const { room, viewers, broadcast } = fixture();
    room.revokeViewers();
    broadcast({ type: "sync", nodes: [], by: null });
    expect(viewers[0]!.send).not.toHaveBeenCalled();
    expect(viewers[1]!.send).toHaveBeenCalledTimes(1);
  });
});
