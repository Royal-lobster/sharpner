import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyBrand, type Actor, type Op, type ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} } }));
vi.mock("@cloudflare/puppeteer", () => ({ default: {} }));
const rooms = vi.hoisted(() => new Map<string, unknown>());
vi.mock("./data", async (original) => ({ ...await original<typeof import("./data")>(), room: (_env: Env, id: string) => rooms.get(id) }));
import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); rooms.clear(); });
const member: Actor = { id: "alice", name: "Alice", avatar: null };
function fixture(id = "file") {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    let rows: unknown[] = [];
    if (!args.length && query.includes(";")) db.exec(query);
    else { const stmt = db.prepare(query); if (stmt.columns().length) rows = stmt.all(...args); else stmt.run(...args); }
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const pending: Promise<unknown>[] = [], broadcasts: ServerMsg[] = [];
  const alarm = vi.fn();
  const ctx = { storage: { sql, getAlarm: async () => null, setAlarm: alarm, transactionSync<T>(fn: () => T) {
    db.exec("SAVEPOINT write");
    try { const result = fn(); db.exec("RELEASE write"); return result; }
    catch (e) { db.exec("ROLLBACK TO write; RELEASE write"); throw e; }
  } }, getWebSockets: () => [], waitUntil: (p: Promise<unknown>) => pending.push(p) } as unknown as DurableObjectState;
  const env = { FILES: { delete: async () => {} }, DB: { prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => ({ name: "FraxNet" }), all: async () => ({ results: id === "library" ? [{ id: "product" }] : [] }) }) }) } } as unknown as Env;
  const wake = () => {
    const room = new FileRoom(ctx, env);
    Object.assign(room, { broadcast: (m: ServerMsg) => broadcasts.push(m) });
    rooms.set(id, room); return room;
  };
  const room = wake(), page = room.pages()[0]!;
  const apply = async (ops: Op[]) => { await room.apply(id, "https://sharpner.example", ops, member); while (pending.length) await Promise.all(pending.splice(0)); };
  return { room, page, db, apply, wake, alarm, broadcasts };
}

describe("Design System document persistence", () => {
  it("patches Brand per file, broadcasts it, and preserves it across hibernation and page deletion", async () => {
    const { room, page, apply, wake, alarm, broadcasts } = fixture();
    expect(room.brand()).toEqual(emptyBrand());
    await apply([{ t: "brand.set", brand: { name: "FraxNet", logoUrl: "/a/logo.png", voice: ["Plain verbs"] } }]);
    await apply([{ t: "brand.set", brand: { guidelines: "Paper, ink and cobalt." } }]);
    expect(room.brand()).toEqual({ name: "FraxNet", logoUrl: "/a/logo.png", voice: ["Plain verbs"], guidelines: "Paper, ink and cobalt." });
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", brand: room.brand() });
    expect(wake().brand()).toEqual(room.brand());
    expect(alarm).not.toHaveBeenCalled();
    await apply([{ t: "page.put", page: { id: "other", name: "Other", sort: 1 } }, { t: "page.del", id: page.id }]);
    expect(room.brand().name).toBe("FraxNet");
    await apply([{ t: "brand.set", brand: { logoUrl: "", voice: [] } }]);
    expect(room.brand()).toMatchObject({ name: "FraxNet", voice: [], logoUrl: "" });
  });

  it("chooses at most one document, keeps nodes on conversion and preserves kind on stale renames", async () => {
    const { room, page, apply, wake } = fixture();
    await apply([{ t: "node.put", id: "screen", node: { pageId: page.id, name: "Existing", source: "<p>Keep me</p>" } }, { t: "page.put", page: { ...page, kind: "design-system" } }]);
    expect(room.pages()[0]!.kind).toBe("design-system");
    await apply([{ t: "page.put", page: { id: page.id, name: "Renamed", sort: page.sort } }]);
    expect(wake().pages()[0]).toMatchObject({ name: "Renamed", kind: "design-system" });
    await apply([{ t: "page.put", page: { id: "second", name: "System", sort: 1, kind: "design-system" } }]);
    expect(room.pages().filter((p) => p.kind === "design-system").map((p) => p.id)).toEqual(["second"]);
    expect(room.node("screen")).toMatchObject({ pageId: page.id, source: "<p>Keep me</p>" });
    await apply([{ t: "page.put", page: { id: "second", name: "System", sort: 1, kind: "canvas" } }]);
    expect(room.pages().some((p) => p.kind === "design-system")).toBe(false);
  });

  it("rolls back invalid Brand and page kinds atomically", async () => {
    const { room, page, apply } = fixture();
    await apply([{ t: "page.put", page: { ...page, kind: "design-system" } }]);
    for (const invalid of [{ t: "brand.set", brand: { logoUrl: "javascript:alert(1)" } }, { t: "brand.set", brand: { voice: "bad" } }, { t: "page.put", page: { id: "invalid", name: "Bad", sort: 1, kind: "other" } }]) {
      await expect(apply([{ t: "brand.set", brand: { name: "Should roll back" } }, invalid as Op])).rejects.toThrow();
      expect(room.brand()).toEqual(emptyBrand());
      expect(room.pages().filter((p) => p.kind === "design-system")).toHaveLength(1);
    }
  });

  it("exports a library's own Brand and registered primitives and updates dependents without thumbnail invalidation", async () => {
    const library = fixture("library"), product = fixture("product");
    product.db.prepare("INSERT INTO meta (k,v) VALUES ('libraryId','library')").run();
    await library.apply([{ t: "brand.set", brand: { name: "FraxNet" } }, { t: "page.put", page: { ...library.page, kind: "design-system" } },
      { t: "node.put", id: "button", node: { pageId: library.page.id, kind: "component", name: "Button/Default", source: "<button>Go</button>" } },
      { t: "page.put", page: { id: "feature", name: "Feature", sort: 1 } }, { t: "node.put", id: "feature", node: { pageId: "feature", kind: "component", name: "Trade/Form", source: "<div>Form</div>" } }]);
    expect(library.room.catalog().primitives.map((n) => n.id)).toEqual(["button"]);
    expect((await product.room.designSystem()).components).toHaveLength(2);
    product.broadcasts.length = 0;
    const rev = library.room.node("button")!.rev;
    await library.apply([{ t: "brand.set", brand: { voice: ["Direct"] } }]);
    const message = product.broadcasts.find((m) => m.type === "library");
    expect(message).toMatchObject({ type: "library", library: { name: "FraxNet", catalog: { brand: { name: "FraxNet", voice: ["Direct"] }, pageId: library.page.id, primitives: [{ id: "button" }] } } });
    expect(library.room.node("button")!.rev).toBe(rev);
    await library.apply([{ t: "node.put", id: "feature", node: { pageId: library.page.id } }]);
    expect(library.room.catalog().primitives).toHaveLength(2);
  });
});
