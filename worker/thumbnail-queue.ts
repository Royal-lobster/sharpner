import { DurableObject } from "cloudflare:workers";
import { room } from "./data";
import { THUMBNAIL_POLICY as policy } from "./thumbnail-policy";

type Job = { fileId: string; teamId: string; readyAt: number };
const DAY_MS = 86_400_000;

/** A single automatic browser across the deployment, with round-robin team/file turns and daily budgets. */
export class ThumbnailQueue extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  overviewPrototype(){
    if(import.meta.env.VITE_OVERVIEW_EXPERIMENT!=="1")throw new Error("Experiment disabled");
    return {at:Date.now(),queue:this.sql.exec(`SELECT * FROM queue`).toArray(),budgets:this.sql.exec(`SELECT * FROM budgets`).toArray(),lease:this.sql.exec(`SELECT * FROM lease`).toArray()};
  }

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS queue (file_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, ready_at INTEGER NOT NULL, turn INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, day INTEGER NOT NULL, spent INTEGER NOT NULL, turn INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), until_ms INTEGER NOT NULL, token TEXT NOT NULL DEFAULT '');`);
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(lease)`).toArray().some((c) => c.name === "token")) this.sql.exec(`ALTER TABLE lease ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
  }

  /** Explicit screenshots share the browser slot, while their usage is reported separately. */
  acquireScreenshot(): string | null {
    if (this.sql.exec(`SELECT 1 FROM lease WHERE id = 1 AND until_ms > ?`, Date.now()).toArray().length) return null;
    const token = crypto.randomUUID();
    this.sql.exec(`INSERT OR REPLACE INTO lease VALUES (1, ?, ?)`, Date.now() + policy.screenshotLeaseMs, token);
    return token;
  }

  async releaseScreenshot(token: string) {
    this.sql.exec(`DELETE FROM lease WHERE id = 1 AND token = ?`, token);
    if (this.sql.exec(`SELECT 1 FROM queue LIMIT 1`).toArray().length) await this.wake(Date.now() + 50);
  }

  async enqueue(fileId: string, readyAt: number): Promise<void> {
    const existing = this.sql.exec(`SELECT 1 FROM queue WHERE file_id = ?`, fileId).toArray().length;
    if (!existing && this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM queue`).toArray()[0]!.n >= policy.maxQueuedFiles) return;
    const file = await this.env.DB.prepare(`SELECT workspace_id FROM files WHERE id = ?`).bind(fileId).first<{ workspace_id: string }>();
    if (!file) return;
    if (!existing && this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM queue`).toArray()[0]!.n >= policy.maxQueuedFiles) return;
    this.sql.exec(`INSERT INTO queue VALUES (?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET ready_at = max(queue.ready_at, excluded.ready_at)`, fileId, file.workspace_id, readyAt, Date.now());
    await this.wake(readyAt);
  }

  private async wake(at: number) {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > at) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, at));
  }

  async alarm() {
    const now = Date.now(), day = Math.floor(now / DAY_MS);
    const lease = this.sql.exec<{ until_ms: number }>(`SELECT until_ms FROM lease WHERE id = 1`).toArray()[0];
    if (lease && lease.until_ms > now) { await this.wake(lease.until_ms); return; }
    this.sql.exec(`DELETE FROM budgets WHERE day != ?`, day);
    const jobs = this.sql.exec<Job>(`SELECT q.file_id AS fileId, q.team_id AS teamId, q.ready_at AS readyAt FROM queue q
      LEFT JOIN budgets b ON b.id = 'team:' || q.team_id
      ORDER BY coalesce(b.turn, 0), q.turn, q.file_id`).toArray();
    let next = (day + 1) * DAY_MS;
    for (const job of jobs) {
      if (job.readyAt > now) { next = Math.min(next, job.readyAt); continue; }
      const limits = [["global", policy.globalDailyMs], [`team:${job.teamId}`, policy.teamDailyMs], [`file:${job.fileId}`, policy.fileDailyMs]] as const;
      const budget = limits.map(([id, limit]) => ({ id, limit, spent: this.sql.exec<{ spent: number }>(`SELECT spent FROM budgets WHERE id = ?`, id).toArray()[0]?.spent ?? 0 }));
      if (budget.some((b) => b.spent + policy.reservationMs > b.limit)) continue;
      // Persist the reservation before yielding. A restart charges the whole reservation and the
      // lease prevents another automatic session until the abandoned session's keep-alive expires.
      this.sql.exec(`INSERT OR REPLACE INTO lease VALUES (1, ?, '')`, now + policy.reservationMs);
      for (const b of budget) this.sql.exec(`INSERT INTO budgets VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET spent = excluded.spent, turn = excluded.turn`, b.id, day, b.spent + policy.reservationMs, now);
      this.sql.exec(`DELETE FROM queue WHERE file_id = ?`, job.fileId);
      await this.ctx.storage.setAlarm(now + policy.reservationMs);
      let spent: number = policy.reservationMs;
      let more = true, completed = false, retryAt = now + 30_000;
      try {
        const result = await room(this.env, job.fileId).renderThumbnails(now + policy.reservationMs - policy.sessionMs - 5000);
        spent = Math.min(policy.reservationMs, Math.max(0, result.browserMs));
        more = result.more;
        retryAt = result.retryAt ?? Date.now() + 500;
        completed = true;
      } catch (error) { console.warn("thumbnail queue turn failed", job.fileId, String(error)); }
      for (const b of budget) this.sql.exec(`UPDATE budgets SET spent = max(0, spent - ?) WHERE id = ? AND day = ?`, policy.reservationMs - spent, b.id, day);
      if (completed) this.sql.exec(`DELETE FROM lease WHERE id = 1`);
      if (more) this.sql.exec(`INSERT OR IGNORE INTO queue VALUES (?, ?, ?, ?)`, job.fileId, job.teamId, retryAt, Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 50);
      return;
    }
    if (jobs.length) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, next));
  }
}
