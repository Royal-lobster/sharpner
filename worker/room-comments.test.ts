import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commentPoint } from "../shared/comments";
import { layoutHeight, layoutRects } from "../shared/layout";
import type { Actor, ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
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
  } };
  const ctx = { storage, waitUntil: vi.fn(), getWebSockets: () => [] } as unknown as DurableObjectState;
  const env = { DB: { prepare: () => ({ bind: () => ({ run: async () => {}, first: async () => null, all: async () => ({ results: [] }) }) }) } } as unknown as Env;
  const broadcasts: ServerMsg[] = [];
  const wake = () => {
    const room = new FileRoom(ctx, env);
    Object.assign(room, { broadcast: (message: ServerMsg) => broadcasts.push(message) });
    return room;
  };
  const room = wake(), pageId = room.pages()[0]!.id;
  const apply = (ops: Parameters<FileRoom["apply"]>[2]) => room.apply("file", "https://sharpner.example", ops, human);
  return { db, room, wake, apply, pageId, broadcasts };
}

describe("persistent file comments", () => {
  it("preserves feedback if an older deployment lowers the recorded migration version", () => {
    const { db, room, wake, pageId } = fixture();
    const thread = room.createComment("file", { pageId, nodeId: null, x: 10, y: 20 }, "Keep this feedback", human);
    // The pre-comments constructor recorded its own schema length even when storage was newer.
    db.prepare("UPDATE meta SET v = '4' WHERE k = 'schema'").run();
    const recovered = wake();
    expect(recovered.comment(thread.id).messages[0]!.body).toBe("Keep this feedback");
    expect(recovered.createComment("file", thread.anchor, "More feedback", human).number).toBeGreaterThan(thread.number);
  });

  it("preserves full feedback, human/agent attribution and resolution across hibernation", () => {
    const { room, wake, pageId, broadcasts } = fixture();
    const body = "Please improve the spacing. ".repeat(30);
    const thread = room.createComment("file", { pageId, nodeId: null, x: 40, y: 80 }, body, human);
    expect(room.comments()[0]!.firstMessage.body).toHaveLength(240);
    expect(room.comment(thread.id).messages[0]!.body).toBe(body.trim());
    room.replyComment("file", thread.id, "Adjusted spacing and checked the screenshot.", agent);
    room.resolveComment("file", thread.id, true, agent);
    const persisted = wake().comment(thread.id);
    expect(persisted).toMatchObject({ messageCount: 2, revision: 3, resolvedBy: agent, resolvedAt: expect.any(Number) });
    expect(persisted.messages.map((m) => m.author)).toEqual([human, agent]);
    expect(broadcasts.filter((m) => m.type === "comments")).toHaveLength(3);
    expect(JSON.stringify(broadcasts)).not.toContain("\"messages\"");
    expect(room.resolveComment("file", thread.id, false, human)).toMatchObject({ resolvedAt: null, resolvedBy: null, messageCount: 2, revision: 4 });
    expect(room.resolveComment("file", thread.id, false, human).revision).toBe(4);
  });

  it("rejects invalid anchors and bodies without partial writes", async () => {
    const { room, pageId, apply } = fixture();
    const anchor = { pageId, nodeId: null, x: 0, y: 0 };
    for (const body of [" ", "a".repeat(5001)]) expect(() => room.createComment("file", anchor, body, human)).toThrow();
    expect(() => room.createComment("file", { ...anchor, x: NaN }, "Feedback", human)).toThrow();
    expect(() => room.createComment("file", { ...anchor, pageId: "other-file-page" }, "Feedback", human)).toThrow("Page not found");
    await apply([{ t: "page.put", page: { id: "other", name: "Other", sort: 1 } }, { t: "node.put", id: "screen", node: { pageId: "other" } }]);
    expect(() => room.createComment("file", { ...anchor, nodeId: "screen" }, "Feedback", human)).toThrow("no longer on this page");
    expect(() => room.replyComment("file", "missing-thread", "Feedback", human)).toThrow("not found");
    expect(room.comments()).toEqual([]);
  });

  it("keeps pins on designs through layout changes, page moves and deletion", async () => {
    const { room, pageId, apply } = fixture();
    await apply([
      { t: "node.put", id: "section", node: { pageId, kind: "section", x: 300, y: 600 } },
      { t: "node.put", id: "screen", node: { pageId, parentId: "section", width: 400, height: 600 } },
    ]);
    const thread = room.createComment("file", { pageId, nodeId: "screen", x: 70, y: 90 }, "Make this button clearer.", human);
    const point = () => commentPoint(room.comment(thread.id).anchor, layoutRects(room.nodes(), layoutHeight));
    const initial = point();
    await apply([{ t: "node.put", id: "section", node: { x: 600 } }]);
    expect(point()).toEqual({ x: initial.x + 300, y: initial.y });
    await apply([{ t: "page.put", page: { id: "second", name: "Second", sort: 1 } }, { t: "node.put", id: "screen", node: { pageId: "second", parentId: null } }]);
    expect(room.comment(thread.id).anchor.pageId).toBe("second");
    const beforeDelete = point();
    await apply([{ t: "node.del", ids: ["screen"] }]);
    expect(room.comment(thread.id).anchor).toEqual({ pageId: "second", nodeId: null, ...beforeDelete });
    expect(room.comment(thread.id).messages[0]!.body).toBe("Make this button clearer.");
  });

  it("removes deleted-page feedback atomically while preserving other pages' threads", async () => {
    const { room, pageId, apply, broadcasts } = fixture();
    await apply([{ t: "page.put", page: { id: "second", name: "Second", sort: 1 } }]);
    const removed = room.createComment("file", { pageId, nodeId: null, x: 0, y: 0 }, "Old page", human);
    const kept = room.createComment("file", { pageId: "second", nodeId: null, x: 0, y: 0 }, "New page", human);
    await expect(apply([{ t: "page.del", id: pageId }, { t: "page.del", id: "second" }])).rejects.toThrow("at least one page");
    expect(room.comments()).toHaveLength(2);
    await apply([{ t: "page.del", id: pageId }]);
    expect(room.comments().map((t) => t.id)).toEqual([kept.id]);
    expect(() => room.comment(removed.id)).toThrow("not found");
    expect(broadcasts.at(-1)).toEqual({ type: "comments", threads: [], deleted: [removed.id] });
    await apply([{ t: "page.put", page: { id: "third", name: "Third", sort: 2 } }, { t: "page.del", id: "second" }]);
    const next = room.createComment("file", { pageId: "third", nodeId: null, x: 0, y: 0 }, "New feedback", human);
    expect(next.number).toBeGreaterThan(kept.number);
  });
});
