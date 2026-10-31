import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor, NodeInput, Op, ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
const renderer = vi.hoisted(() => ({ launch: vi.fn(), loadFrame: vi.fn(), capture: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: renderer.launch } }));
vi.mock("./render", async (original) => ({ ...await original<typeof import("./render")>(), loadFrame: renderer.loadFrame, capture: renderer.capture }));
import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
beforeEach(() => {
  renderer.launch.mockReset().mockResolvedValue({ newPage: async () => ({}), close: async () => {} });
  renderer.loadFrame.mockReset().mockResolvedValue({ width: 1600, height: 900, measured: 900 });
  renderer.capture.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});
const member: Actor = { id: "alice", name: "Alice", avatar: null };

function fixture(browser = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    let rows: unknown[] = [];
    if (!args.length && query.includes(";")) db.exec(query);
    else {
      const statement = db.prepare(query);
      if (statement.columns().length) rows = statement.all(...args);
      else statement.run(...args);
    }
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const storage = { sql, getAlarm: async () => null, setAlarm: vi.fn(async () => {}), transactionSync<T>(fn: () => T): T {
    db.exec("SAVEPOINT write");
    try { const value = fn(); db.exec("RELEASE write"); return value; }
    catch (error) { db.exec("ROLLBACK TO write; RELEASE write"); throw error; }
  } };
  const pending = new Set<Promise<unknown>>();
  const ctx = { storage, getWebSockets: () => [], waitUntil(promise: Promise<unknown>) {
    const settled = promise.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  } } as unknown as DurableObjectState;
  const projected: (string | null)[] = [];
  const project = vi.fn(async (url: string | null) => { projected.push(url); });
  const env = {
    ...(browser ? { BROWSER: {} } : {}),
    FILES: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    DB: { prepare: (query: string) => ({ bind: (...args: (string | number | null)[]) => ({
      run: () => query.includes("SET cover") ? project(args[0] as string | null) : Promise.resolve(),
      all: async () => ({ results: [] }), first: async () => null,
    }) }) },
  } as unknown as Env;
  const broadcasts: ServerMsg[] = [];
  const wake = () => {
    const room = new FileRoom(ctx, env);
    Object.assign(room, { broadcast: (message: ServerMsg) => broadcasts.push(message) });
    return room;
  };
  const room = wake(), pageId = room.pages()[0]!.id;
  const flush = async () => { while (pending.size) await Promise.all([...pending]); };
  const apply = async (ops: Op[]) => { await room.apply("file", "https://sharpner.example", ops, member); await flush(); };
  const create = (id: string, node: NodeInput = {}) => apply([{ t: "node.put", id, node: { pageId, width: 1600, height: 900, source: `<p>${id}</p>`, ...node } }]);
  const preview = (id: string, suffix = "ready") => {
    const lo = `/a/file/t/${id}-${suffix}-lo.webp`, hi = `/a/file/t/${id}-${suffix}-hi.webp`;
    db.prepare("UPDATE nodes SET thumb_lo = ?, thumb_hi = ?, thumb_rev = rev WHERE id = ?").run(lo, hi, id);
    return { lo, hi };
  };
  return { db, room, wake, pageId, apply, create, preview, broadcasts, flush, project, projected, env };
}

describe("persistent file covers", () => {
  it("pins a frame, survives edits and hibernation, and explicitly resets to automatic", async () => {
    const { room, wake, create, preview, apply, broadcasts, projected } = fixture();
    await create("first"); const first = preview("first");
    await create("cover"); const cover = preview("cover");
    await apply([{ t: "cover.set", id: "cover" }]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: cover.hi });
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", coverNodeId: "cover" });
    await apply([{ t: "node.put", id: "cover", node: { name: "Renamed cover", source: "<h1>Updated</h1>" } }]);
    await apply([{ t: "node.put", id: "first", node: { source: "<p>Edited first screen</p>" } }]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: cover.hi });
    expect(wake().cover()).toEqual(room.cover());
    await apply([{ t: "cover.set", id: null }]);
    expect(room.cover()).toEqual({ nodeId: null, url: first.hi });
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", coverNodeId: null });
    expect(projected).toContain(cover.hi);
    expect(projected.at(-1)).toBe(first.hi);
  });

  it("keeps automatic selection stable when earlier screens are edited", async () => {
    const { room, create, preview, apply } = fixture();
    await create("first"); const first = preview("first");
    await create("second"); preview("second");
    await apply([{ t: "node.put", id: "first", node: { source: "<p>Updated</p>" } }]);
    expect(room.cover()).toEqual({ nodeId: null, url: first.hi });
    await apply([{ t: "node.put", id: "second", node: { order: -1 } }]);
    expect(room.cover().url).toContain("second-ready-hi.webp");
  });

  it("preserves a pending pin, then uses its rendered revision and refreshes after design-system edits", async () => {
    const { room, create, preview, apply, projected } = fixture(true);
    await create("first"); const first = preview("first");
    await create("cover");
    await apply([{ t: "cover.set", id: "cover" }]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: first.hi });
    await room.alarm();
    await apply([]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: "/a/file/t/cover-1-hi.webp" });
    expect(projected.at(-1)).toBe("/a/file/t/cover-1-hi.webp");
    await create("tokens", { kind: "tokens", source: "@theme { --color-primary: #abcdef; }" });
    expect(room.node("cover")!.rev).toBe(2);
    expect(room.cover().url).toBe("/a/file/t/cover-1-hi.webp");
    await room.alarm();
    await apply([]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: "/a/file/t/cover-2-hi.webp" });
    expect(projected.at(-1)).toBe("/a/file/t/cover-2-hi.webp");
  });

  it("accepts image covers using their bounded preview rather than their original upload", async () => {
    const { room, create, apply } = fixture();
    await create("image", { kind: "image", src: "/a/file/u/original.png", thumbLo: "/a/file/u/preview.webp" });
    await apply([{ t: "cover.set", id: "image" }]);
    expect(room.cover()).toEqual({ nodeId: "image", url: "/a/file/u/preview.webp" });
  });

  it("preserves the pin when its frame or page moves or is renamed", async () => {
    const { room, pageId, create, preview, apply } = fixture();
    await create("cover"); const cover = preview("cover");
    await apply([{ t: "cover.set", id: "cover" }, { t: "page.put", page: { id: "new", name: "New page", sort: -1 } }]);
    await apply([{ t: "node.put", id: "cover", node: { pageId: "new" } }, { t: "page.put", page: { id: pageId, name: "Renamed page", sort: 20 } }]);
    expect(room.cover()).toEqual({ nodeId: "cover", url: cover.hi });
  });

  it.each(["frame", "section", "page"] as const)("clears the pin when its containing %s is deleted", async (target) => {
    const { room, pageId, create, preview, apply, broadcasts } = fixture();
    await apply([{ t: "page.put", page: { id: "remaining", name: "Remaining", sort: 1 } }]);
    await create("fallback", { pageId: "remaining" }); const fallback = preview("fallback");
    await create("section", { kind: "section" });
    await create("cover", { parentId: "section" }); preview("cover");
    await apply([{ t: "cover.set", id: "cover" }]);
    await apply([target === "page" ? { t: "page.del", id: pageId } : { t: "node.del", ids: [target === "section" ? "section" : "cover"] }]);
    expect(room.cover()).toEqual({ nodeId: null, url: fallback.hi });
    expect(broadcasts.findLast((message) => message.type === "sync")).toMatchObject({ coverNodeId: null });
  });

  it("rejects foreign or unsupported nodes atomically, and clears a pin replaced by an unsupported kind", async () => {
    const { room, create, preview, apply } = fixture();
    await create("cover"); preview("cover");
    await create("component", { kind: "component" });
    await apply([{ t: "cover.set", id: "cover" }]);
    for (const id of ["foreign-file-frame", "component", ""]) {
      await expect(apply([{ t: "node.put", id: "partial", node: { name: "Must roll back" } }, { t: "cover.set", id }])).rejects.toThrow(/cover/i);
      expect(room.node("partial")).toBeNull();
      expect(room.cover().nodeId).toBe("cover");
    }
    await apply([{ t: "node.del", ids: ["cover"] }, { t: "node.put", id: "cover", node: { kind: "component", name: "Changed" } }]);
    expect(room.cover().nodeId).toBeNull();
  });

  it("retries an unsuccessful D1 projection on the next activity", async () => {
    const { room, create, preview, apply, project, projected } = fixture();
    await create("cover"); const cover = preview("cover");
    project.mockRejectedValueOnce(new Error("D1 unavailable"));
    await apply([{ t: "cover.set", id: "cover" }]);
    expect(room.cover().url).toBe(cover.hi);
    expect(projected).not.toContain(cover.hi);
    await apply([]);
    expect(projected.at(-1)).toBe(cover.hi);
    expect(project).toHaveBeenCalledTimes(2);
  });

  it("coalesces edits while a D1 write is pending and mirrors the latest choice last", async () => {
    const { room, create, preview, flush, project, projected } = fixture();
    await create("first"); const first = preview("first");
    await create("second"); const second = preview("second");
    project.mockClear();
    projected.length = 0;
    let release!: () => void;
    project.mockImplementationOnce(async (url) => { await new Promise<void>((resolve) => { release = resolve; }); projected.push(url); });
    await room.apply("file", "https://sharpner.example", [{ t: "cover.set", id: "second" }], member);
    await room.apply("file", "https://sharpner.example", [{ t: "cover.set", id: "first" }], member);
    expect(project).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(projected.slice(-2)).toEqual([second.hi, first.hi]);
    expect(room.cover()).toEqual({ nodeId: "first", url: first.hi });
  });
});
