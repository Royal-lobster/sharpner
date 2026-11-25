import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Actor, ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
const human: Actor = { id: "alice", name: "Alice", avatar: null };
const agent: Actor = { ...human, name: "Alice's agent", agent: true };

function fixture() {
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
  const storage = { sql, transactionSync<T>(fn: () => T): T {
    db.exec("SAVEPOINT write");
    try { const result = fn(); db.exec("RELEASE write"); return result; }
    catch (e) { db.exec("ROLLBACK TO write; RELEASE write"); throw e; }
  }, setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} };
  const ctx = { storage, waitUntil: vi.fn(), getWebSockets: () => [] } as unknown as DurableObjectState;
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => null, all: async () => ({ results: [] }) }) }) },
    FILES: { delete: async () => {} } } as unknown as Env;
  const broadcasts: ServerMsg[] = [];
  const wake = () => {
    const room = new FileRoom(ctx, env);
    Object.assign(room, { broadcast: (message: ServerMsg) => broadcasts.push(message), scheduleThumbs: async () => {} });
    return room;
  };
  const room = wake(), pageId = room.pages()[0]!.id;
  const apply = (ops: Parameters<FileRoom["apply"]>[2]) => room.apply("file", "https://sharpner.example", ops, agent);
  return { db, room, wake, apply, pageId, broadcasts };
}

const at = (ms: number) => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(ms); };

describe("design dates", () => {
  it("records creation, keeps it, and moves the change date only when what the node renders changes", async () => {
    const { room, apply, pageId } = fixture();
    at(1_000);
    await apply([{ t: "node.put", id: "home", node: { pageId, kind: "frame", name: "Home", source: "<main>Hi</main>", width: 390 } }]);
    expect(room.nodes(["home"])[0]).toMatchObject({ createdAt: 1_000, changedAt: 1_000 });
    at(2_000);
    await apply([{ t: "node.put", id: "home", node: { name: "Home screen", order: 5 } }]);
    expect(room.nodes(["home"])[0]).toMatchObject({ createdAt: 1_000, changedAt: 1_000 });
    at(3_000);
    await apply([{ t: "node.put", id: "home", node: { source: "<main>Hello</main>" } }]);
    expect(room.nodes(["home"])[0]).toMatchObject({ createdAt: 1_000, changedAt: 3_000 });
    at(4_000);
    await apply([{ t: "node.put", id: "home", node: { width: 1280 } }]);
    expect(room.node("home")).toMatchObject({ createdAt: 1_000, changedAt: 4_000 });
  });

  it("dates a design-system change on every frame it reaches", async () => {
    const { room, apply, pageId } = fixture();
    at(1_000);
    await apply([
      { t: "node.put", id: "button", node: { pageId, kind: "component", name: "Button", source: "<button>{{label}}</button>" } },
      { t: "node.put", id: "uses", node: { pageId, kind: "frame", name: "Uses", source: "<x-button></x-button>" } },
      { t: "node.put", id: "plain", node: { pageId, kind: "frame", name: "Plain", source: "<p>No button</p>" } },
    ]);
    at(5_000);
    await apply([{ t: "node.put", id: "button", node: { source: "<button class='big'>{{label}}</button>" } }]);
    expect(room.node("uses")!.changedAt).toBe(5_000);
    expect(room.node("plain")!.changedAt).toBe(1_000);
  });

  it("leaves nodes made before dates were recorded undated, and keeps the stored dates if the migration replays", async () => {
    const { db, room, wake, apply, pageId } = fixture();
    at(1_000);
    await apply([{ t: "node.put", id: "home", node: { pageId, kind: "frame", name: "Home", source: "<main/>" } }]);
    db.prepare("UPDATE nodes SET created_at = NULL, changed_at = NULL").run();
    room.approve("file", ["home"], true, human);
    expect(room.node("home")).toMatchObject({ createdAt: null, changedAt: null });
    db.prepare("UPDATE meta SET v = CAST(v AS INTEGER) - 1 WHERE k = 'schema'").run();
    db.prepare("UPDATE nodes SET created_at = 7, changed_at = 8").run();
    const replayed = wake();
    expect(replayed.node("home")).toMatchObject({ createdAt: 7, changedAt: 8 });
    expect(replayed.approvals()).toHaveLength(1);
  });
});

describe("approvals", () => {
  it("records who approved a frame and when, survives hibernation, and broadcasts to members", async () => {
    const { room, wake, apply, pageId, broadcasts } = fixture();
    at(1_000);
    await apply([{ t: "node.put", id: "home", node: { pageId, kind: "frame", name: "Home", source: "<main/>" } }]);
    at(2_000);
    broadcasts.length = 0;
    expect(room.approve("file", ["home"], true, human)).toEqual([{ nodeId: "home", approvedAt: 2_000, approvedBy: human }]);
    expect(broadcasts).toEqual([{ type: "approvals", approvals: [{ nodeId: "home", approvedAt: 2_000, approvedBy: human }] }]);
    expect(wake().approvals()).toEqual([{ nodeId: "home", approvedAt: 2_000, approvedBy: human }]);
  });

  it("keeps an approval through later changes, so a member sees it changed since approval", async () => {
    const { room, apply, pageId } = fixture();
    at(1_000);
    await apply([{ t: "node.put", id: "home", node: { pageId, kind: "frame", name: "Home", source: "<main/>" } }]);
    at(2_000);
    room.approve("file", ["home"], true, agent);
    at(3_000);
    await apply([{ t: "node.put", id: "home", node: { source: "<main>Changed</main>" } }]);
    expect(room.approvals()).toEqual([{ nodeId: "home", approvedAt: 2_000, approvedBy: agent }]);
    expect(room.node("home")!.changedAt).toBe(3_000);
    at(4_000);
    room.approve("file", ["home"], true, human);
    expect(room.approvals()).toEqual([{ nodeId: "home", approvedAt: 4_000, approvedBy: human }]);
  });

  it("withdraws approvals and deletes them with their frame", async () => {
    const { room, apply, pageId, broadcasts } = fixture();
    await apply([
      { t: "node.put", id: "a", node: { pageId, kind: "frame", name: "A", source: "<main/>" } },
      { t: "node.put", id: "b", node: { pageId, kind: "frame", name: "B", source: "<main/>" } },
    ]);
    room.approve("file", ["a", "b"], true, human);
    broadcasts.length = 0;
    expect(room.approve("file", ["a"], false, human)).toEqual([]);
    expect(broadcasts).toEqual([{ type: "approvals", approvals: [], deleted: ["a"] }]);
    await apply([{ t: "node.del", ids: ["b"] }]);
    expect(room.approvals()).toEqual([]);
  });

  it("refuses anything but an existing frame, and changes nothing when one id fails", async () => {
    const { room, apply, pageId } = fixture();
    await apply([
      { t: "node.put", id: "home", node: { pageId, kind: "frame", name: "Home", source: "<main/>" } },
      { t: "node.put", id: "button", node: { pageId, kind: "component", name: "Button", source: "<button/>" } },
    ]);
    expect(() => room.approve("file", ["home", "button"], true, human)).toThrow("Only frames can be approved; Button is a component");
    expect(() => room.approve("file", ["missing"], true, human)).toThrow("Design missing not found");
    expect(room.approvals()).toEqual([]);
  });
});
