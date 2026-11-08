import { DurableObject } from "cloudflare:workers";
import { closeBrowser } from "./browser-session";
import { room } from "./data";
import { backfilling, THUMBNAIL_POLICY as policy } from "./thumbnail-policy";

type Job = { fileId: string; teamId: string; readyAt: number };
const DAY_MS = 86_400_000;

/** A single automatic browser across the deployment, with round-robin team/file turns and daily budgets. */
export class ThumbnailQueue extends DurableObject<Env> {
  private sql = this.ctx.storage.sql;
  /** Screenshot callers poll every 250ms; while one waits, automatic turns yield the slot. */
  private screenshotWaitingUntil = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS queue (file_id TEXT PRIMARY KEY, team_id TEXT NOT NULL, ready_at INTEGER NOT NULL, turn INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS budgets (id TEXT PRIMARY KEY, day INTEGER NOT NULL, spent INTEGER NOT NULL, turn INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), until_ms INTEGER NOT NULL, token TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS warm (id INTEGER PRIMARY KEY CHECK (id = 1), session TEXT NOT NULL, until_ms INTEGER NOT NULL);`);
    if (!this.sql.exec<{ name: string }>(`PRAGMA table_info(lease)`).toArray().some((c) => c.name === "token")) this.sql.exec(`ALTER TABLE lease ADD COLUMN token TEXT NOT NULL DEFAULT ''`);
  }

  /** Explicit screenshots share the browser slot, while their usage is reported separately. */
  acquireScreenshot(): string | null {
    if (this.sql.exec(`SELECT 1 FROM lease WHERE id = 1 AND until_ms > ?`, Date.now()).toArray().length) {
      this.screenshotWaitingUntil = Date.now() + 1000;
      return null;
    }
    this.screenshotWaitingUntil = 0;
    const token = crypto.randomUUID();
    this.sql.exec(`INSERT OR REPLACE INTO lease VALUES (1, ?, ?)`, Date.now() + policy.screenshotLeaseMs, token);
    return token;
  }

  async releaseScreenshot(token: string) {
    this.sql.exec(`DELETE FROM lease WHERE id = 1 AND token = ?`, token);
    if (this.sql.exec(`SELECT 1 FROM queue LIMIT 1`).toArray().length) await this.wake(Date.now() + 50);
  }

  /** Closes the browser a turn left warm once no turn reused it in time; until then, returns when to check. */
  private async cool(now: number): Promise<number | undefined> {
    const warm = this.sql.exec<{ session: string; until_ms: number }>(`SELECT session, until_ms FROM warm WHERE id = 1`).toArray()[0];
    if (!warm) return undefined;
    if (now < warm.until_ms) return warm.until_ms;
    // Forget it before yielding, so no turn reconnects to a browser that is closing.
    this.sql.exec(`DELETE FROM warm`);
    if (this.env.BROWSER) await closeBrowser(this.env.BROWSER, warm.session);
    console.log("thumbnail-browser-closed", JSON.stringify({ idleMs: now - warm.until_ms + policy.warmMs }));
    return undefined;
  }

  async enqueue(fileId: string, readyAt: number): Promise<void> {
    const existing = this.sql.exec(`SELECT 1 FROM queue WHERE file_id = ?`, fileId).toArray().length;
    if (existing) {
      this.sql.exec(`UPDATE queue SET ready_at = max(ready_at, ?) WHERE file_id = ?`, readyAt, fileId);
      return this.wake(readyAt);
    }
    if (this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM queue`).toArray()[0]!.n >= policy.maxQueuedFiles) return;
    const file = await this.env.DB.prepare(`SELECT workspace_id FROM files WHERE id = ?`).bind(fileId).first<{ workspace_id: string }>();
    if (!file) return;
    if (this.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM queue`).toArray()[0]!.n >= policy.maxQueuedFiles) return;
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
    if (this.screenshotWaitingUntil > now) { await this.ctx.storage.setAlarm(this.screenshotWaitingUntil); return; }
    this.sql.exec(`DELETE FROM budgets WHERE day != ?`, day);
    const jobs = this.sql.exec<Job>(`SELECT q.file_id AS fileId, q.team_id AS teamId, q.ready_at AS readyAt FROM queue q
      LEFT JOIN budgets b ON b.id = 'team:' || q.team_id
      ORDER BY coalesce(b.turn, 0), q.turn, q.file_id`).toArray()
      // Files someone is viewing go before the backfill; the sort is stable, so fair rotation holds within each group.
      .sort((a, b) => Number(backfilling(a.fileId, now)) - Number(backfilling(b.fileId, now)));
    let next = (day + 1) * DAY_MS;
    const deferred: { fileId: string; exhausted: string[] }[] = [];
    const spentOn = (id: string) => this.sql.exec<{ spent: number }>(`SELECT spent FROM budgets WHERE id = ?`, id).toArray()[0]?.spent ?? 0;
    const admitted: { job: Job; budget: { id: string; spent: number }[] }[] = [];
    for (const job of jobs) {
      if (job.readyAt > now) { next = Math.min(next, job.readyAt); continue; }
      const normal = [["global", policy.globalDailyMs], [`team:${job.teamId}`, policy.teamDailyMs], [`file:${job.fileId}`, policy.fileDailyMs]] as const;
      // A backfilling file spends its own budget first, so it cannot use up the time viewed files need.
      // Once that is spent it is charged like any file, so someone working in it still gets previews.
      const options = backfilling(job.fileId, now) ? [[["backfill", policy.backfillDailyMs] as const], normal] : [normal];
      let exhausted: string[] = [];
      for (const charged of options) {
        const budget = charged.map(([id, limit]) => ({ id, limit, spent: spentOn(id) }));
        exhausted = budget.filter((b) => b.spent + policy.reservationMs > b.limit).map((b) => b.id);
        if (!exhausted.length) { admitted.push({ job, budget }); break; }
      }
      if (exhausted.length) deferred.push({ fileId: job.fileId, exhausted });
    }
    for (const { job, budget } of admitted.slice(0, 1)) {
      // Only files that could run now compete for the browser.
      const alone = admitted.length === 1;
      // Persist the reservation before yielding. A restart charges the whole reservation and the
      // lease prevents another automatic session until the abandoned session's keep-alive expires.
      this.sql.exec(`INSERT OR REPLACE INTO lease VALUES (1, ?, '')`, now + policy.reservationMs);
      for (const b of budget) this.sql.exec(`INSERT INTO budgets VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET spent = excluded.spent, turn = excluded.turn`, b.id, day, b.spent + policy.reservationMs, now);
      this.sql.exec(`DELETE FROM queue WHERE file_id = ?`, job.fileId);
      await this.ctx.storage.setAlarm(now + policy.reservationMs);
      let spent: number = policy.reservationMs;
      let more = true, completed = false, retryAt = now + 30_000;
      // The browser the previous turn left running for this one. Turns run one at a time, so no other turn holds it.
      const warmRow = this.sql.exec<{ session: string; until_ms: number }>(`SELECT session, until_ms FROM warm WHERE id = 1 AND until_ms > ?`, now).toArray()[0];
      const warm = warmRow?.session;
      this.sql.exec(`DELETE FROM warm`);
      // A turn leaves its browser running only for work that is due at once; another file waiting is one case.
      const keepWarm = admitted.length > 1;
      try {
        const result = await room(this.env, job.fileId).renderThumbnails(now + policy.reservationMs - policy.sessionMs - 5000, alone ? policy.soloQuantumMs : policy.quantumMs, warm, keepWarm);
        // A turn that never opened a browser leaves the warm one as it was.
        if (result.warm === undefined && warmRow) this.sql.exec(`INSERT OR REPLACE INTO warm VALUES (1, ?, ?)`, warmRow.session, warmRow.until_ms);
        else if (result.warm) this.sql.exec(`INSERT OR REPLACE INTO warm VALUES (1, ?, ?)`, result.warm, Date.now() + policy.warmMs);
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
    // Previews then wait for the next UTC day; say so, because the canvas only shows "Rendering…".
    if (deferred.length) console.log("thumbnail-deferred", JSON.stringify({ deferred: deferred.slice(0, 20), files: deferred.length }));
    const coolAt = await this.cool(Date.now());
    if (jobs.length || coolAt) await this.ctx.storage.setAlarm(Math.max(Date.now() + 50, Math.min(jobs.length ? next : Infinity, coolAt ?? Infinity)));
  }
}
