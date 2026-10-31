import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, setApiTokenGetter } from "./api";
import { cancelFileStartup, claimFileStartup, prepareFileStartup, type FileMeta } from "./file-startup";
import type { ServerMsg } from "../shared/types";
import type { SessionPrincipal } from "../shared/session-principal";

class Socket {
  static OPEN = 1;
  static instances: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  sent: unknown[] = [];
  close = vi.fn(() => { this.readyState = 3; });
  constructor() { Socket.instances.push(this); }
  send(data: string) { this.sent.push(JSON.parse(data)); }
  receive(message: ServerMsg) { this.onmessage?.({ data: JSON.stringify(message) }); }
}

const principal: SessionPrincipal = { clerkUserId: "clerk_person", sessionId: "session_one", organizationId: "org_one" };
const metadata = (): FileMeta => ({
  // Deliberately different from the immutable Clerk ID, as with migrated accounts.
  user: { id: "legacy_author", name: "Member", login: "member", avatar_url: null },
  file: { id: "file_one", name: "Private file", workspace_id: "local_workspace", library_id: null },
  workspace: { id: "local_workspace", clerkOrganizationId: "org_one", name: "Workspace", role: "owner" },
  files: [], shareToken: null, principal, sessionExpiresAt: Date.now() + 60_000,
});
const init = (patch: Partial<Extract<ServerMsg, { type: "init" }>> = {}): ServerMsg => ({
  type: "init", cid: "connection", pages: [{ id: "page", name: "Private page", sort: 0 }], nodes: [], peers: [], library: null,
  principal, sessionExpiresAt: Date.now() + 60_000, ...patch,
});
const fetcher = vi.fn<typeof fetch>();
const flush = () => vi.advanceTimersByTimeAsync(0);
const socket = () => Socket.instances.at(-1)!;
let claimed: ReturnType<typeof claimFileStartup>;

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("document", { cookie: "unrelated=x; __session=hint" });
  vi.stubGlobal("location", { protocol: "https:", host: "sharpner.example" });
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async () => Response.json(metadata()));
  setApiTokenGetter(null);
  claimed = null;
});
afterEach(() => { claimed?.dispose(); cancelFileStartup(); setApiTokenGetter(null); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("direct-file startup ownership and identity", () => {
  it.each(["metadata", "socket"])("overlaps SDK startup and transfers the same Room with %s first", async (first) => {
    let respond!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const release = prepareFileStartup("file_one");
    expect(Socket.instances).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledWith("/api/files/file_one", expect.objectContaining({ credentials: "same-origin", cache: "no-store", signal: expect.any(AbortSignal) }));
    socket().onopen?.();
    if (first === "metadata") { respond(Response.json(metadata())); await flush(); }
    else socket().receive(init());
    expect(socket().sent).toEqual([]);
    const getter = vi.fn(async () => "sdk-token");
    setApiTokenGetter(getter);
    claimed = claimFileStartup("file_one", principal);
    release(); // Parent route cleanup after claim must leave Editor's connection alive.
    if (first === "metadata") socket().receive(init());
    else respond(Response.json(metadata()));
    const opened = await claimed!.ready;
    expect(opened?.meta.user.id).toBe("legacy_author");
    expect(opened?.room.pages[0]?.name).toBe("Private page");
    expect(socket().close).not.toHaveBeenCalled();
    expect(getter).not.toHaveBeenCalled();
    expect(socket().sent).toContainEqual({ type: "presence", presence: { pageId: null, selection: [], cursor: null } });
    expect(Socket.instances).toHaveLength(1);
    claimed!.dispose();
    expect(socket().close).toHaveBeenCalledTimes(1);
  });

  it.each([
    { clerkUserId: "other" }, { clerkUserId: "legacy_author" }, { sessionId: "other" },
    { organizationId: "other" }, { organizationId: null },
  ])("discards a server/SDK mismatch before returning private data: %j", async (patch) => {
    prepareFileStartup("file_one"); socket().receive(init()); await flush();
    claimed = claimFileStartup("file_one", { ...principal, ...patch });
    expect(await claimed!.ready).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
    expect(socket().sent).toEqual([]);
  });

  it.each([
    { principal: { ...principal, sessionId: "other" } }, { principal: undefined }, { sessionExpiresAt: 0 },
  ])("discards mismatched, old and expired socket init promptly: %j", async (patch) => {
    prepareFileStartup("file_one"); socket().receive(init(patch)); await flush();
    claimed = claimFileStartup("file_one", principal);
    expect(await claimed!.ready).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it.each([401, 403, 503, "legacy", "wrong-file", "wrong-session", "expired", "oversized"])("makes %s metadata a prompt fallback", async (failure) => {
    fetcher.mockImplementation(async () => typeof failure === "number" ? new Response(null, { status: failure }) : Response.json({ ...metadata(),
      ...(failure === "legacy" ? { principal: undefined } : failure === "wrong-file" ? { file: { ...metadata().file, id: "other" } }
        : failure === "wrong-session" ? { principal: { ...principal, sessionId: "other" } }
        : failure === "expired" ? { sessionExpiresAt: Date.now() } : { padding: "x".repeat(1024 * 1024) }),
    }));
    prepareFileStartup("file_one"); socket().receive(init()); await flush();
    claimed = claimFileStartup("file_one", principal);
    expect(await claimed!.ready).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it("aborts on route departure and ignores late metadata and socket callbacks", async () => {
    let respond!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const release = prepareFileStartup("file_one");
    const late = socket().onmessage;
    const signal = fetcher.mock.calls[0]![1]!.signal;
    release();
    expect(signal?.aborted).toBe(true);
    respond(Response.json(metadata())); late?.({ data: JSON.stringify(init()) }); await flush();
    expect(claimFileStartup("file_one", principal)).toBeNull();
    expect(socket().sent).toEqual([]);
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it("cleans up StrictMode setup/cleanup/setup and replaces rather than accumulating pending files", async () => {
    prepareFileStartup("file_one")();
    prepareFileStartup("file_one");
    const previous = socket();
    prepareFileStartup("file_two");
    expect(Socket.instances.slice(0, -1).every((ws) => ws.close.mock.calls.length === 1)).toBe(true);
    expect(previous.close).toHaveBeenCalledOnce();
    expect(claimFileStartup("file_one", principal)).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
    await flush();
  });

  it("bounds an unresponsive attempt and a claimed attempt disposed while waiting", async () => {
    fetcher.mockReturnValue(new Promise(() => {}));
    prepareFileStartup("file_one");
    claimed = claimFileStartup("file_one", principal);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await claimed!.ready).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });

  it("does not let an old route release cancel a replacement for the same file", async () => {
    const releaseOld = prepareFileStartup("file_one");
    prepareFileStartup("file_one");
    const current = socket();
    releaseOld();
    expect(current.close).not.toHaveBeenCalled();
    current.receive(init()); await flush();
    claimed = claimFileStartup("file_one", principal);
    expect((await claimed!.ready)?.meta.file.id).toBe("file_one");
    expect(current.close).not.toHaveBeenCalled();
  });

  it("cancels an Editor-owned claim while metadata is still in flight", async () => {
    let respond!: (response: Response) => void;
    fetcher.mockReturnValue(new Promise((resolve) => { respond = resolve; }));
    const release = prepareFileStartup("file_one");
    claimed = claimFileStartup("file_one", principal);
    socket().receive(init());
    claimed!.dispose(); release(); respond(Response.json(metadata())); await flush();
    expect(await claimed!.ready).toBeNull();
    expect(socket().close).toHaveBeenCalledOnce();
    expect(socket().sent).toEqual([]);
  });

  it.each([4403, 4001, 1006])("ends speculation on socket close %s without a reconnect or renewal", async (code) => {
    prepareFileStartup("file_one");
    socket().onclose?.({ code });
    claimed = claimFileStartup("file_one", principal);
    expect(await claimed!.ready).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("releases an expired lease before SDK readiness instead of retaining it until the startup deadline", async () => {
    fetcher.mockImplementation(async () => Response.json({ ...metadata(), sessionExpiresAt: Date.now() + 100 }));
    prepareFileStartup("file_one"); socket().receive(init()); await flush();
    await vi.advanceTimersByTimeAsync(100);
    expect(socket().close).toHaveBeenCalledOnce();
    claimed = claimFileStartup("file_one", principal);
    expect(await claimed!.ready).toBeNull();
  });

  it.each([
    { principal: { ...principal, sessionId: "changed" } }, { principal: undefined },
    { sessionExpiresAt: 0 }, { sessionExpiresAt: undefined },
  ])("rejects a changed or expired identity on reconnect after adoption: %j", async (patch) => {
    prepareFileStartup("file_one"); socket().receive(init()); await flush();
    claimed = claimFileStartup("file_one", principal);
    const opened = await claimed!.ready;
    expect(opened?.room.pages).toHaveLength(1);
    socket().receive(init(patch));
    expect(opened?.room.status).toBe("denied");
    expect(opened?.room.pages).toEqual([]);
    expect(opened?.room.nodes.size).toBe(0);
    expect(socket().close).toHaveBeenCalledOnce();
  });

  it.each(["bytes", "messages"])("bounds speculative socket %s without sending source requests or reconnecting", async (bound) => {
    prepareFileStartup("file_one");
    socket().receive(init());
    if (bound === "bytes") socket().onmessage?.({ data: "x".repeat(2 * 1024 * 1024) });
    else for (let i = 0; i < 128; i++) socket().receive({ type: "sync", nodes: [], by: null });
    claimed = claimFileStartup("file_one", principal);
    expect(await claimed!.ready).toBeNull();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(Socket.instances).toHaveLength(1);
    expect(socket().sent).toEqual([]);
  });

  it("does no speculative work without a cookie hint", () => {
    vi.stubGlobal("document", { cookie: "__session=; other=present" });
    prepareFileStartup("file_one");
    expect(fetcher).not.toHaveBeenCalled(); expect(Socket.instances).toHaveLength(0);
  });

  it("preserves api()'s null-to-SDK account change cancellation", async () => {
    const request = api("/files/file_one");
    setApiTokenGetter(async () => "sdk-token");
    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
