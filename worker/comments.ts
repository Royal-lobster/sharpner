import { commentBody, commentAnchor } from "./comment-schema";
import { commentPoint } from "../shared/comments";
import type { Rect } from "../shared/layout";
import type { Actor, CanvasNode, CommentAnchor, CommentDetail, CommentMessage, CommentThread } from "../shared/types";

export const COMMENT_SCHEMA = `CREATE TABLE comment_threads (
  id TEXT PRIMARY KEY, page_id TEXT NOT NULL, node_id TEXT, data TEXT NOT NULL);
  CREATE INDEX comment_threads_page ON comment_threads(page_id);
  CREATE TABLE comment_messages (id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, data TEXT NOT NULL);
  CREATE INDEX comment_messages_thread ON comment_messages(thread_id);`;

/** Synchronous SQLite operations run within the room's transaction. Authors always come from verified identity. */
export class Comments {
  constructor(private sql: SqlStorage) {}

  list(): CommentThread[] {
    return this.sql.exec<{ data: string }>(`SELECT data FROM comment_threads ORDER BY rowid`)
      .toArray().map((row) => JSON.parse(row.data) as CommentThread);
  }

  get(id: string): CommentDetail {
    const row = this.sql.exec<{ data: string }>(`SELECT data FROM comment_threads WHERE id = ?`, id).toArray()[0];
    if (!row) throw new Error("Comment thread not found");
    const messages = this.sql.exec<{ data: string }>(`SELECT data FROM comment_messages WHERE thread_id = ? ORDER BY rowid`, id)
      .toArray().map((row) => JSON.parse(row.data) as CommentMessage);
    return { ...JSON.parse(row.data) as CommentThread, messages };
  }

  create(anchor: CommentAnchor, body: string, author: Actor): CommentDetail {
    anchor = commentAnchor.parse(anchor);
    body = commentBody.parse(body);
    const now = Date.now();
    const number = this.sql.exec<{ n: number }>(`INSERT INTO meta(k, v) VALUES ('commentNumber', '1')
      ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1 RETURNING CAST(v AS INTEGER) AS n`).toArray()[0]!.n;
    const message: CommentMessage = { id: crypto.randomUUID(), author, body, createdAt: now };
    const thread: CommentThread = {
      id: crypto.randomUUID(), number,
      anchor, firstMessage: { ...message, body: body.slice(0, 240) }, messageCount: 1,
      createdAt: now, updatedAt: now, resolvedAt: null, resolvedBy: null, revision: 1,
    };
    this.save(thread);
    this.message(thread.id, message);
    return { ...thread, messages: [message] };
  }

  reply(id: string, body: string, author: Actor): CommentDetail {
    body = commentBody.parse(body);
    const thread = this.get(id);
    if (thread.messages.length >= 200) throw new Error("This thread is full. Start a new comment to continue.");
    const message: CommentMessage = { id: crypto.randomUUID(), author, body, createdAt: Date.now() };
    thread.messages.push(message);
    thread.messageCount++;
    thread.updatedAt = message.createdAt;
    thread.revision++;
    this.message(id, message);
    this.save(thread);
    return thread;
  }

  resolve(id: string, resolved: boolean, by: Actor): CommentDetail {
    if (typeof resolved !== "boolean") throw new Error("resolved must be a boolean");
    const thread = this.get(id);
    if ((thread.resolvedAt !== null) === resolved) return thread;
    thread.resolvedAt = resolved ? Date.now() : null;
    thread.resolvedBy = resolved ? by : null;
    thread.updatedAt = Date.now();
    thread.revision++;
    this.save(thread);
    return thread;
  }

  /** Preserve feedback when a node is deleted; follow nodes moved to another page; remove deleted pages' threads. */
  reconcile(nodes: ReadonlyMap<string, CanvasNode>, pages: ReadonlySet<string>, before: ReadonlyMap<string, Rect>) {
    const threads: CommentThread[] = [], deleted: string[] = [];
    for (const thread of this.list()) {
      const node = thread.anchor.nodeId ? nodes.get(thread.anchor.nodeId) : undefined;
      if (node && node.pageId !== thread.anchor.pageId) {
        thread.anchor = { ...thread.anchor, pageId: node.pageId };
      } else if (!pages.has(thread.anchor.pageId)) {
        this.sql.exec(`DELETE FROM comment_messages WHERE thread_id = ?`, thread.id);
        this.sql.exec(`DELETE FROM comment_threads WHERE id = ?`, thread.id);
        deleted.push(thread.id);
        continue;
      } else if (thread.anchor.nodeId && !node) {
        thread.anchor = { ...thread.anchor, nodeId: null, ...commentPoint(thread.anchor, before) };
      } else continue;
      thread.revision++;
      this.save(thread);
      threads.push(thread);
    }
    return { threads, deleted };
  }

  private message(id: string, message: CommentMessage) {
    this.sql.exec(`INSERT INTO comment_messages VALUES (?, ?, ?)`, message.id, id, JSON.stringify(message));
  }

  private save(thread: CommentThread) {
    const { messages: _messages, ...summary } = thread as CommentDetail;
    this.sql.exec(`INSERT INTO comment_threads VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET
      page_id = excluded.page_id, node_id = excluded.node_id, data = excluded.data`,
    thread.id, thread.anchor.pageId, thread.anchor.nodeId, JSON.stringify(summary));
  }
}
