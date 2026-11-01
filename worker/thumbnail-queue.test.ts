import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} } }));
const calls = vi.hoisted(() => ({ render: vi.fn() }));
vi.mock("./data", () => ({ room: (_env: unknown, fileId: string) => ({ renderThumbnails: () => calls.render(fileId) }) }));
import { ThumbnailQueue } from "./thumbnail-queue";
import { BACKFILL, THUMBNAIL_POLICY as policy } from "./thumbnail-policy";
const databases: DatabaseSync[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); calls.render.mockReset().mockResolvedValue({ more: false, browserMs: 1000, rendered: 4 }); });
afterEach(() => { vi.useRealTimers(); for (const db of databases.splice(0)) db.close(); });
function fixture() {
  const db = new DatabaseSync(":memory:"); databases.push(db);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    let rows: unknown[] = [];
    if (!args.length && query.includes(";")) db.exec(query);
    else { const stmt = db.prepare(query); if (stmt.columns().length) rows = stmt.all(...args); else stmt.run(...args); }
    return { toArray: () => rows };
  } };
  let alarm: number | null = null;
  const ctx = { storage: { sql, getAlarm: async () => alarm, setAlarm: async (at: number) => { alarm = at; } } } as unknown as DurableObjectState;
  const env = { DB: { prepare: () => ({ bind: (fileId: string) => ({ first: async () => fileId === "deleted" ? null : {workspace_id:fileId.split("-")[0]} }) }) } } as unknown as Env;
  const wake = () => new ThumbnailQueue(ctx, env), queue = wake();
  const fire = async () => { alarm = null; await queue.alarm(); };
  return {db, queue, wake, fire, alarm: () => alarm};
}

describe("shared automatic render budget", () => {
  it("coalesces requests, debounces, and rotates teams before returning to another file in one team", async () => {
    const {queue, fire, db} = fixture();
    for (const id of ["a-one", "a-two", "b-one"]) await queue.enqueue(id, Date.now()+1200);
    await queue.enqueue("a-one", Date.now()+1500);
    expect(db.prepare("SELECT count(*) AS n FROM queue").get()).toEqual({n:3});
    await fire(); expect(calls.render).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1500);
    await fire(); await fire(); await fire();
    expect(calls.render.mock.calls.flat()).toEqual(["a-one", "b-one", "a-two"]);
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:3000});
  });

  it("never starts two automatic browsers, including across a coordinator restart", async () => {
    const {queue, fire, wake} = fixture();
    let finish!: (value: unknown) => void;
    calls.render.mockImplementationOnce(() => new Promise((resolve) => {finish=resolve;}));
    await queue.enqueue("a-one", Date.now()); await queue.enqueue("b-one", Date.now());
    const running = fire();
    await vi.advanceTimersByTimeAsync(0);
    await wake().alarm();
    expect(calls.render).toHaveBeenCalledTimes(1);
    finish({more:true, browserMs:4000, rendered:20}); await running;
    await fire(); expect(calls.render.mock.calls.flat()).toEqual(["a-one", "b-one"]);
  });

  it.each([["file:a-one", policy.fileDailyMs], ["team:a",policy.teamDailyMs], ["global",policy.globalDailyMs]])("reserves before starting and stops at the %s budget", async (id, limit) => {
    const {queue, fire, db, alarm} = fixture();
    await queue.enqueue("a-one", Date.now());
    const day = Math.floor(Date.now()/86_400_000);
    db.prepare("INSERT INTO budgets VALUES (?, ?, ?, 0)").run(id,day,limit-policy.reservationMs+1);
    await fire(); expect(calls.render).not.toHaveBeenCalled();
    expect(alarm()).toBe((day+1)*86_400_000);
    vi.setSystemTime((day+1)*86_400_000); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
  });

  it("charges a backfilling file to the global budget only, until the backfill expires", async () => {
    const {queue, fire, db} = fixture();
    const file = [...BACKFILL.files][0]!, team = file.split("-")[0];
    vi.setSystemTime(BACKFILL.until - 86_400_000);
    const day = Math.floor(Date.now()/86_400_000);
    db.prepare("INSERT INTO budgets VALUES (?, ?, ?, 0)").run(`file:${file}`,day,policy.fileDailyMs);
    db.prepare("INSERT INTO budgets VALUES (?, ?, ?, 0)").run(`team:${team}`,day,policy.teamDailyMs);
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:1000});
    expect(db.prepare("SELECT spent FROM budgets WHERE id = ?").get(`file:${file}`)).toEqual({spent:policy.fileDailyMs});
    // Expired: the file's own exhausted budget applies again.
    vi.setSystemTime(BACKFILL.until + 1000);
    db.prepare("UPDATE budgets SET day = ? WHERE id != 'global'").run(Math.floor(Date.now()/86_400_000));
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
  });

  it("charges failed turns conservatively and does no browser work for an idle/deleted file", async () => {
    const {queue, fire, db} = fixture();
    await queue.enqueue("deleted",Date.now()); expect(db.prepare("SELECT count(*) AS n FROM queue").get()).toEqual({n:0});
    await queue.enqueue("a-one",Date.now()); calls.render.mockResolvedValueOnce({more:false,browserMs:0,rendered:0});
    await fire(); expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:0});
    await queue.enqueue("a-one",Date.now()); calls.render.mockRejectedValueOnce(new Error("room unavailable"));
    await fire(); expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:policy.reservationMs});
  });
});

describe("explicit screenshot admission", () => {
  it("shares the global browser slot and only the matching lease can release it", async () => {
    const {queue,fire} = fixture();
    const lease = queue.acquireScreenshot(); expect(lease).toBeTruthy();
    expect(queue.acquireScreenshot()).toBeNull();
    await queue.enqueue("a-one",Date.now()); await fire();
    expect(calls.render).not.toHaveBeenCalled();
    await queue.releaseScreenshot("different request");
    expect(queue.acquireScreenshot()).toBeNull();
    await queue.releaseScreenshot(lease!); await fire();
    // The screenshot that just polled keeps priority over the automatic turn for one poll window.
    expect(calls.render).not.toHaveBeenCalled();
    expect(queue.acquireScreenshot()).toBeTruthy();
    expect(calls.render).not.toHaveBeenCalled();
  });
  it("resumes automatic turns once no screenshot is waiting", async () => {
    const {queue,fire} = fixture();
    const lease = queue.acquireScreenshot();
    expect(queue.acquireScreenshot()).toBeNull();
    await queue.enqueue("a-one",Date.now());
    await queue.releaseScreenshot(lease!);
    vi.advanceTimersByTime(1001); await fire();
    expect(calls.render).toHaveBeenCalledWith("a-one");
  });
  it("bounds queued files without displacing existing requests", async () => {
    const {db,queue} = fixture();
    const insert=db.prepare("INSERT INTO queue VALUES (?, 'a', 0, 0)");
    for(let i=0;i<policy.maxQueuedFiles;i++) insert.run(`a-${i}`);
    await queue.enqueue("a-overflow",Date.now());
    expect(db.prepare("SELECT count(*) AS n FROM queue").get()).toEqual({n:policy.maxQueuedFiles});
    await queue.enqueue("a-0",Date.now()+1000);
    expect(db.prepare("SELECT ready_at FROM queue WHERE file_id='a-0'").get()).toEqual({ready_at:Date.now()+1000});
  });
});
