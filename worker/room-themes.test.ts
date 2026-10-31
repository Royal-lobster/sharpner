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
  renderer.loadFrame.mockReset().mockResolvedValue({ width: 400, height: 600, measured: 600 });
  renderer.capture.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
});
const member: Actor = { id: "alice", name: "Alice", avatar: null };

function fixture(browser = false, sockets: { deserializeAttachment(): unknown }[] = []) {
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
  const ctx = { storage, getWebSockets: () => sockets, waitUntil(promise: Promise<unknown>) {
    const settled = promise.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  } } as unknown as DurableObjectState;
  const env = {
    ...(browser ? { BROWSER: {} } : {}),
    FILES: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    DB: { prepare: () => ({ bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }) }) },
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
  const create = (id: string, node: NodeInput = {}) => apply([{ t: "node.put", id, node: { pageId, width: 400, height: 600, source: `<p>${id}</p>`, ...node } }]);
  const cached = () => db.exec("UPDATE nodes SET thumb_rev = rev, thumb_tries = 3, measured_h = 400");
  return { db, room, wake, apply, create, cached, broadcasts, storage };
}

describe("file and screen themes", () => {
  it("persists a file default and screen overrides across hibernation without rewriting sources", async () => {
    const { room, wake, apply, create, broadcasts } = fixture();
    await create("screen", { source: '<main class="dark">Screen</main>' });
    await create("override", { theme: "uwu" });
    expect(room.theme()).toBeNull();
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.theme()).toBe("dark");
    expect(room.node("screen")!.source).toBe('<main class="dark">Screen</main>');
    expect(room.node("override")!.theme).toBe("uwu");
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", fileTheme: "dark" });
    const restored = wake();
    expect(restored.theme()).toBe("dark");
    expect(restored.node("override")!.theme).toBe("uwu");
    await apply([{ t: "theme.set", theme: null }]);
    expect(room.theme()).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", fileTheme: null });
  });

  it("refreshes only inheriting screens and component specimens when the file default changes", async () => {
    const { db, room, apply, create, cached, broadcasts, storage } = fixture(true);
    await create("tokens", { kind: "tokens", source: '@theme { --color-primary: red; } [data-theme="dark"] { --color-primary: blue; }' });
    await create("component", { kind: "component", name: "Button" });
    await create("screen");
    await create("override", { theme: "light" });
    await create("section", { kind: "section" });
    await create("image", { kind: "image", src: "/a/file/original.png", thumbLo: "/a/file/preview.webp" });
    cached();
    const before = new Map(room.nodes().map((n) => [n.id, n.rev]));
    storage.setAlarm.mockClear();
    await apply([{ t: "theme.set", theme: "dark" }]);
    for (const id of ["screen", "component"]) {
      // The previous measurement holds the layout until the restyled thumbnail measures again.
      expect(room.node(id)).toMatchObject({ rev: before.get(id)! + 1, thumbRev: before.get(id), measuredHeight: 400 });
      expect(db.prepare("SELECT thumb_tries FROM nodes WHERE id = ?").get(id)).toEqual({ thumb_tries: 0 });
    }
    for (const id of ["tokens", "override", "section", "image"]) {
      expect(room.node(id)).toMatchObject({ rev: before.get(id), measuredHeight: 400 });
    }
    expect(storage.setAlarm).toHaveBeenCalled();
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", nodes: expect.arrayContaining([expect.objectContaining({ id: "screen" }), expect.objectContaining({ id: "component" })]) });
    const rev = room.node("screen")!.rev;
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.node("screen")!.rev).toBe(rev);
  });

  it("refreshes thumbnails on pages people are viewing before the rest of the file", async () => {
    const viewer = { presence: { pageId: "viewed", selection: [], cursor: null } };
    const { room, apply, create, cached } = fixture(true, [{ deserializeAttachment: () => viewer }]);
    for (let i = 0; i < 30; i++) await create(`elsewhere-${i}`);
    await apply([{ t: "page.put", page: { id: "viewed", name: "Viewed", sort: 2 } }]);
    await apply(["a", "b"].map((id) => ({ t: "node.put", id: `viewed-${id}`, node: { pageId: "viewed", width: 400, height: 600, source: `<p>${id}</p>` } })));
    cached();
    await apply([{ t: "theme.set", theme: "dark" }]);
    renderer.loadFrame.mockClear();
    await room.alarm();
    const rendered = renderer.loadFrame.mock.calls.map(([, node]) => (node as { id: string }).id);
    expect(rendered.slice(0, 2).sort()).toEqual(["viewed-a", "viewed-b"]);
    expect(room.node("viewed-a")).toMatchObject({ thumbRev: room.node("viewed-a")!.rev });
  });

  it("keeps an override through unrelated edits and resumes inheritance when cleared", async () => {
    const { room, apply, create, cached } = fixture();
    await create("screen");
    await apply([{ t: "theme.set", theme: "dark" }]);
    cached();
    const original = room.node("screen")!;
    await apply([{ t: "node.put", id: "screen", node: { theme: " light " } }]);
    expect(room.node("screen")).toMatchObject({ theme: "light", rev: original.rev + 1, measuredHeight: 400, source: original.source });
    await apply([{ t: "node.put", id: "screen", node: { name: "Renamed" } }, { t: "theme.set", theme: "uwu" }]);
    expect(room.node("screen")).toMatchObject({ theme: "light", rev: original.rev + 1 });
    await apply([{ t: "node.put", id: "screen", node: { theme: null } }]);
    expect(room.node("screen")!.theme ?? null).toBeNull();
    expect(room.node("screen")!.rev).toBe(original.rev + 2);
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.node("screen")!.rev).toBe(original.rev + 3);
  });

  it("rolls back malformed themes and overrides on unsupported node kinds", async () => {
    const { room, apply, create } = fixture();
    await create("screen");
    await create("component", { kind: "component", name: "Button" });
    await apply([{ t: "theme.set", theme: "dark" }]);
    const rev = room.node("screen")!.rev;
    for (const theme of ["", "   ", "x".repeat(81), 42, undefined]) {
      await expect(apply([{ t: "node.put", id: "partial", node: {} }, { t: "theme.set", theme } as Op])).rejects.toThrow(/theme/i);
      expect(room.node("partial")).toBeNull();
      expect(room.theme()).toBe("dark");
      expect(room.node("screen")!.rev).toBe(rev);
    }
    await expect(apply([{ t: "theme.set", theme: "light" }, { t: "node.put", id: "component", node: { theme: "dark" } }])).rejects.toThrow(/screens/i);
    expect(room.theme()).toBe("dark");
    expect(room.node("component")!.theme ?? null).toBeNull();
  });

  it("renders cached previews with the same effective theme as live screens, leaving token comparisons intact", async () => {
    const { room, apply, create } = fixture(true);
    await create("tokens", { kind: "tokens", source: '@theme { --color-primary: red; } [data-theme="dark"] { --color-primary: blue; }' });
    await create("component", { kind: "component", name: "Button" });
    await create("screen");
    await create("override", { theme: "uwu" });
    await apply([{ t: "theme.set", theme: "dark" }]);
    await room.alarm();
    const renders = new Map(renderer.loadFrame.mock.calls.map(([, node]) => [node.id, node.theme]));
    expect(renders).toEqual(new Map([["tokens", undefined], ["component", "dark"], ["screen", "dark"], ["override", "uwu"]]));
  });
});
