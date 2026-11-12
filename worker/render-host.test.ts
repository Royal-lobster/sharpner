import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} } }));
const calls = vi.hoisted(() => ({ render: vi.fn(), hosted: [] as boolean[] }));
vi.mock("./data", () => ({ room: () => ({ renderThumbnails: (_notAfter: number, _quantumMs: number, _warm?: string, _keepWarm = false, hosted = false) => { calls.hosted.push(hosted); return calls.render(); } }) }));
vi.mock("./browser-session", () => ({ closeBrowser: vi.fn() }));
vi.mock("./room", () => ({ FileRoom: class {} }));
vi.mock("./mcp", async () => ({ mcp: new (await import("hono")).Hono() }));
import app from "./index";
import { HOST_ACQUIRE_MS, hostServes, hostToken } from "./render-host";
import { THUMBNAIL_POLICY as policy } from "./thumbnail-policy";
import { ThumbnailQueue } from "./thumbnail-queue";

/** One end of a socket as a Durable Object holds it: what was sent to it, its attachment and whether it is closed. */
class Socket {
  readyState = WebSocket.OPEN as number;
  sent: string[] = [];
  private attachment: unknown = null;
  send(message: string) { this.sent.push(message); }
  close() { this.readyState = WebSocket.CLOSED; }
  serializeAttachment(value: unknown) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}

const databases: DatabaseSync[] = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000);
  calls.render.mockReset().mockResolvedValue({ more: false, browserMs: 1000, rendered: 4 }); calls.hosted.length = 0;
  vi.stubGlobal("WebSocketPair", class { 0 = new Socket(); 1 = new Socket(); });
  vi.stubGlobal("WebSocketRequestResponsePair", class {});
  // Node's Response refuses status 101; a Worker's carries the client end of the pair.
  const Plain = Response;
  vi.stubGlobal("Response", class extends Plain {
    constructor(body?: BodyInit | null, init?: ResponseInit) {
      super(body, init?.status === 101 ? { ...init, status: 200 } : init);
      if (init?.status === 101) Object.defineProperty(this, "status", { value: 101 });
    }
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); for (const db of databases.splice(0)) db.close(); });

function fixture(env: Partial<Env> = { RENDER_HOST_TOKEN: "secret", RENDER_HOST_WORKSPACES: "team" }) {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    let rows: unknown[] = [];
    if (!args.length && query.includes(";")) db.exec(query);
    else { const stmt = db.prepare(query); if (stmt.columns().length) rows = stmt.all(...args); else stmt.run(...args); }
    return { toArray: () => rows };
  } };
  let alarm: number | null = null;
  const sockets: { ws: Socket; tags: string[] }[] = [];
  const ctx = {
    storage: { sql, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } },
    acceptWebSocket: (ws: Socket, tags: string[] = []) => { sockets.push({ ws, tags }); },
    getWebSockets: (tag?: string) => sockets.filter((s) => s.ws.readyState === WebSocket.OPEN && (!tag || s.tags.includes(tag))).map((s) => s.ws),
    setWebSocketAutoResponse: () => {},
  } as unknown as DurableObjectState;
  // A file's workspace is the part of its id before the dash.
  const DB = { prepare: () => ({ bind: (fileId: string) => ({ first: async () => fileId ? { workspace_id: fileId.split("-")[0] } : null }) }) };
  const queue = new ThumbnailQueue(ctx, { BROWSER: {}, DB, ...env } as unknown as Env);
  const fire = async () => { alarm = null; await queue.alarm(); };
  const call = (path: string, init: RequestInit = {}) => queue.fetch(new Request(`https://render-host${path}`, init));
  /** A render host parks an idle browser; returns the queue's end of its socket. */
  const park = async () => { await call("/socket", { headers: { upgrade: "websocket" } }); return sockets.at(-1)!.ws; };
  const acquire = (fileId = "team-file") => call("/v1/devtools/browser", { method: "POST", headers: { "x-file": fileId } });
  /** A FileRoom connects to its session; returns the queue's end of the room's socket. */
  const attach = async (session: string) => { const response = await call(`/v1/devtools/browser/${session}`, { headers: { upgrade: "websocket" } }); return { response, room: sockets.at(-1)!.ws }; };
  return { db, queue, fire, park, acquire, attach };
}

describe("render host settings", () => {
  it("serves only the workspaces a deployment names, and none without a token", () => {
    expect(hostServes({ RENDER_HOST_TOKEN: "secret", RENDER_HOST_WORKSPACES: "team, other" }, "other")).toBe(true);
    expect(hostServes({ RENDER_HOST_TOKEN: "secret", RENDER_HOST_WORKSPACES: "team" }, "stranger")).toBe(false);
    expect(hostServes({ RENDER_HOST_TOKEN: "secret", RENDER_HOST_WORKSPACES: "*" }, "stranger")).toBe(true);
    expect(hostServes({ RENDER_HOST_TOKEN: "secret" }, "team")).toBe(false);
    expect(hostServes({ RENDER_HOST_WORKSPACES: "*" }, "team")).toBe(false);
  });

  it("accepts only the deployment's token", async () => {
    expect(await hostToken({ RENDER_HOST_TOKEN: "secret" }, "secret")).toBe(true);
    for (const presented of ["Secret", "secre", "secret ", "", undefined]) expect(await hostToken({ RENDER_HOST_TOKEN: "secret" }, presented)).toBe(false);
    expect(await hostToken({}, "")).toBe(false);
    expect(await hostToken({}, "secret")).toBe(false);
  });
});

describe("render host socket route", () => {
  const request = (headers: Record<string, string>, env: Partial<Env>) => app.request("https://sharpner.example/api/render-host/socket", { headers }, env as Env);
  const forwarded = vi.fn(async () => new Response("parked"));
  const env = { RENDER_HOST_TOKEN: "secret", THUMBNAIL_QUEUE: { idFromName: () => "global", get: () => ({ fetch: forwarded }) } } as unknown as Partial<Env>;

  it("reaches the queue only with the token, as a WebSocket upgrade, and never from a web page", async () => {
    const upgrade = { upgrade: "websocket" };
    expect((await request({ ...upgrade }, env)).status).toBe(404);
    expect((await request({ ...upgrade, authorization: "Bearer wrong" }, env)).status).toBe(404);
    expect((await request({ ...upgrade, authorization: "Bearer secret", origin: "https://sharpner.example" }, env)).status).toBe(404);
    expect((await request({ authorization: "Bearer secret" }, env)).status).toBe(426);
    // A deployment without a token has no such route.
    expect((await request({ ...upgrade, authorization: "Bearer secret" }, { ...env, RENDER_HOST_TOKEN: undefined })).status).toBe(404);
    expect(forwarded).not.toHaveBeenCalled();
    expect(await (await request({ ...upgrade, authorization: "Bearer secret" }, env)).text()).toBe("parked");
    expect(forwarded).toHaveBeenCalledTimes(1);
  });
});

describe("render host sessions", () => {
  it("lends a parked browser to a served file's room and passes the protocol both ways", async () => {
    const { park, acquire, attach, queue } = fixture();
    expect((await acquire()).status).toBe(503);
    const host = await park();
    expect((await acquire("stranger-file")).status).toBe(403);
    const { sessionId } = await (await acquire()).json() as { sessionId: string };
    // The only browser is taken.
    expect((await acquire()).status).toBe(503);
    expect((await attach("someone-elses-session")).response.status).toBe(404);
    const { response, room } = await attach(sessionId);
    expect(response.status).toBe(101);
    // One room per session.
    expect((await attach(sessionId)).response.status).toBe(404);
    queue.webSocketMessage(room as unknown as WebSocket, `{"id":1,"method":"Browser.getVersion"}`);
    queue.webSocketMessage(host as unknown as WebSocket, `{"id":1,"result":{}}`);
    expect(host.sent).toEqual([`{"id":1,"method":"Browser.getVersion"}`]);
    expect(room.sent).toEqual([`{"id":1,"result":{}}`]);
  });

  it("ends the session at both ends when either closes, so the host replaces its browser", async () => {
    const { park, acquire, attach, queue } = fixture();
    const host = await park();
    const first = await attach((await (await acquire()).json() as { sessionId: string }).sessionId);
    queue.webSocketClose(first.room as unknown as WebSocket);
    expect(host.readyState).toBe(WebSocket.CLOSED);
    // The host parks a fresh browser; this time the browser goes first.
    const next = await park();
    const second = await attach((await (await acquire()).json() as { sessionId: string }).sessionId);
    queue.webSocketClose(next as unknown as WebSocket);
    expect(second.room.readyState).toBe(WebSocket.CLOSED);
  });

  it("gives up a session nobody connected to, so a room that was reset does not strand a browser", async () => {
    const { park, acquire } = fixture();
    const host = await park();
    expect((await acquire()).status).toBe(200);
    vi.advanceTimersByTime(HOST_ACQUIRE_MS + 1);
    expect((await acquire()).status).toBe(503);
    expect(host.readyState).toBe(WebSocket.CLOSED);
  });
});

describe("turns on a render host", () => {
  const spent = (db: DatabaseSync) => (db.prepare("SELECT coalesce(sum(spent), 0) AS n FROM budgets").get() as { n: number }).n;

  it("runs a served file's turn on a parked browser without spending budget, even when the budgets are spent", async () => {
    const { db, queue, fire, park } = fixture();
    db.prepare("INSERT INTO budgets VALUES ('global', ?, ?, 0)").run(Math.floor(Date.now() / 86_400_000), policy.globalDailyMs);
    await queue.enqueue("team-file", Date.now());
    await fire();
    // No host: the budget decides, and it is spent.
    expect(calls.hosted).toEqual([]);
    await park();
    await fire();
    expect(calls.hosted).toEqual([true]);
    expect(spent(db)).toBe(policy.globalDailyMs);
    expect(db.prepare("SELECT 1 FROM lease").all()).toEqual([]);
  });

  it("uses Browser Run, on budget, for a workspace the host does not serve and when no browser is parked", async () => {
    const { db, queue, fire, park } = fixture();
    await queue.enqueue("team-file", Date.now());
    await fire();
    expect(calls.hosted).toEqual([false]);
    expect(spent(db)).toBe(3 * 1000);
    await park();
    await queue.enqueue("stranger-file", Date.now());
    await fire();
    expect(calls.hosted).toEqual([false, false]);
  });

  it("frees the browser slot at once after a hosted turn fails, since the host's browser ended with it", async () => {
    const { db, queue, fire, park } = fixture();
    await park();
    calls.render.mockRejectedValueOnce(new Error("Network connection lost."));
    await queue.enqueue("team-file", Date.now());
    await fire();
    expect(calls.hosted).toEqual([true]);
    expect(db.prepare("SELECT 1 FROM lease").all()).toEqual([]);
    expect(queue.acquireScreenshot()).toEqual(expect.any(String));
  });
});
