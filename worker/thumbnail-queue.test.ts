import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} } }));
const calls = vi.hoisted(() => ({ render: vi.fn(), close: vi.fn(), quantum: [] as number[], warm: [] as (string | undefined)[], keepWarm: [] as boolean[] }));
vi.mock("./data", () => ({ room: (_env: unknown, fileId: string) => ({ renderThumbnails: (_notAfter: number, quantumMs: number, warm?: string, keepWarm = false) => { calls.quantum.push(quantumMs); calls.warm.push(warm); calls.keepWarm.push(keepWarm); return calls.render(fileId); } }) }));
vi.mock("./browser-session", () => ({ closeBrowser: calls.close }));
import { ThumbnailQueue } from "./thumbnail-queue";
import { BACKFILL, THUMBNAIL_POLICY as policy } from "./thumbnail-policy";
const databases: DatabaseSync[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(1_800_000_000_000); calls.render.mockReset().mockResolvedValue({ more: false, browserMs: 1000, rendered: 4 }); calls.close.mockReset(); calls.quantum.length = 0; calls.warm.length = 0; calls.keepWarm.length = 0; });
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
  const env = { BROWSER: {}, DB: { prepare: () => ({ bind: (fileId: string) => ({ first: async () => fileId === "deleted" ? null : {workspace_id:fileId.split("-")[0]} }) }) } } as unknown as Env;
  const wake = () => new ThumbnailQueue(ctx, env), queue = wake();
  const fire = async () => { alarm = null; await queue.alarm(); };
  return {db, queue, wake, fire, alarm: () => alarm};
}

describe("warm browser", () => {
  it("hands the browser one turn left running to the next turn, across files, until its keep-alive runs short", async () => {
    const {queue, fire} = fixture();
    calls.render.mockResolvedValueOnce({ more: false, browserMs: 1000, rendered: 4, warm: "session-1" })
      .mockResolvedValueOnce({ more: false, browserMs: 0, rendered: 0 })
      .mockResolvedValueOnce({ more: false, browserMs: 900, rendered: 2, warm: "session-1" })
      .mockResolvedValueOnce({ more: false, browserMs: 900, rendered: 2, warm: null });
    await queue.enqueue("a-one", Date.now()); await fire();
    // A turn that opened no browser keeps the warm one for the turn after it.
    await queue.enqueue("b-one", Date.now()); await fire();
    await queue.enqueue("a-two", Date.now()); await fire();
    await queue.enqueue("b-two", Date.now()); await fire();
    // That turn closed its browser, so the next one launches.
    calls.render.mockResolvedValueOnce({ more: false, browserMs: 900, rendered: 2, warm: "session-2" });
    await queue.enqueue("a-one", Date.now()); await fire();
    expect(calls.warm).toEqual([undefined, "session-1", "session-1", "session-1", undefined]);
    vi.advanceTimersByTime(policy.keepAliveMs - 5000);
    await queue.enqueue("b-one", Date.now()); await fire();
    expect(calls.warm.at(-1)).toBeUndefined();
  });

  it("asks a turn to keep its browser only when another file is waiting, and closes one nobody reuses in time", async () => {
    const {queue, fire, alarm} = fixture();
    await queue.enqueue("a-one", Date.now()); await fire();
    expect(calls.keepWarm).toEqual([false]);
    // Two files are ready, so the first turn's browser serves the second.
    await queue.enqueue("a-two", Date.now()); await queue.enqueue("b-one", Date.now());
    calls.render.mockResolvedValueOnce({ more: true, browserMs: 1000, rendered: 4, warm: "session-1", retryAt: Date.now() + 500 });
    await fire();
    expect(calls.keepWarm.at(-1)).toBe(true);
    await fire();
    expect(calls.warm.at(-1)).toBe("session-1");
    expect(calls.keepWarm.at(-1)).toBe(false);
    // That turn opened no browser, so the warm one stays for the first file's remaining work, due in 500 ms.
    await fire();
    expect(alarm()).toBe(Date.now() + 500);
    vi.advanceTimersByTime(500); await fire();
    expect(calls.warm.at(-1)).toBe("session-1");
    expect(calls.close).not.toHaveBeenCalled();
    // Nothing else is due, so the queue closes the browser once its warm window passes.
    await fire();
    expect(alarm()).toBe(Date.now() - 500 + policy.warmMs);
    vi.advanceTimersByTime(policy.warmMs); await fire();
    expect(calls.close).toHaveBeenCalledWith({}, "session-1");
    expect(alarm()).toBeNull();
    await queue.enqueue("a-one", Date.now()); await fire();
    expect(calls.warm.at(-1)).toBeUndefined();
  });
});

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

  it("charges a backfilling file to its own budget only, until the backfill expires", async () => {
    const {queue, fire, db} = fixture();
    const file = [...BACKFILL.files][0]!, team = file.split("-")[0];
    vi.setSystemTime(BACKFILL.until - 86_400_000);
    const day = Math.floor(Date.now()/86_400_000);
    db.prepare("INSERT INTO budgets VALUES (?, ?, ?, 0)").run(`file:${file}`,day,policy.fileDailyMs);
    db.prepare("INSERT INTO budgets VALUES (?, ?, ?, 0)").run(`team:${team}`,day,policy.teamDailyMs);
    db.prepare("INSERT INTO budgets VALUES ('global', ?, ?, 0)").run(day,policy.globalDailyMs);
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'backfill'").get()).toEqual({spent:1000});
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:policy.globalDailyMs});
    expect(db.prepare("SELECT spent FROM budgets WHERE id = ?").get(`file:${file}`)).toEqual({spent:policy.fileDailyMs});
    db.prepare("UPDATE budgets SET spent = ? WHERE id = 'backfill'").run(policy.backfillDailyMs);
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
    // Expired: the file's own exhausted budget applies again.
    vi.setSystemTime(BACKFILL.until + 1000);
    db.prepare("UPDATE budgets SET day = ?, spent = 0 WHERE id = 'global'").run(Math.floor(Date.now()/86_400_000));
    db.prepare("UPDATE budgets SET day = ? WHERE id != 'global'").run(Math.floor(Date.now()/86_400_000));
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledTimes(1);
  });

  it("charges a backfilling file like any file once its own budget is spent", async () => {
    const {queue, fire, db} = fixture();
    const file = [...BACKFILL.files][0]!;
    vi.setSystemTime(BACKFILL.until - 86_400_000);
    db.prepare("INSERT INTO budgets VALUES ('backfill', ?, ?, 0)").run(Math.floor(Date.now()/86_400_000), policy.backfillDailyMs);
    await queue.enqueue(file, Date.now()); await fire();
    expect(calls.render).toHaveBeenCalledWith(file);
    expect(db.prepare("SELECT spent FROM budgets WHERE id = ?").get(`file:${file}`)).toEqual({spent:1000});
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'global'").get()).toEqual({spent:1000});
    expect(db.prepare("SELECT spent FROM budgets WHERE id = 'backfill'").get()).toEqual({spent:policy.backfillDailyMs});
  });

  it("gives the longer turn when every other ready file is out of budget", async () => {
    const {queue, fire, db} = fixture();
    db.prepare("INSERT INTO budgets VALUES ('file:b-one', ?, ?, 0)").run(Math.floor(Date.now()/86_400_000), policy.fileDailyMs);
    await queue.enqueue("a-one", Date.now()); await queue.enqueue("b-one", Date.now());
    await fire();
    expect(calls.render.mock.calls.flat()).toEqual(["a-one"]);
    expect(calls.quantum).toEqual([policy.soloQuantumMs]);
  });

  it("renders a viewed file before a backfilling file that has waited longer", async () => {
    const {queue, fire} = fixture();
    const file = [...BACKFILL.files][0]!;
    vi.setSystemTime(BACKFILL.until - 86_400_000);
    await queue.enqueue(file, Date.now());
    vi.advanceTimersByTime(1000);
    await queue.enqueue("z-viewed", Date.now());
    await fire(); await fire();
    expect(calls.render.mock.calls.flat()).toEqual(["z-viewed", file]);
  });

  it("gives a file the longer turn only while no other file is ready", async () => {
    const {queue, fire} = fixture();
    await queue.enqueue("a-one", Date.now()); await queue.enqueue("b-one", Date.now());
    await fire(); await fire();
    expect(calls.quantum).toEqual([policy.quantumMs, policy.soloQuantumMs]);
  });

  it("logs which budgets deferred a file", async () => {
    const {queue, fire, db} = fixture();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    db.prepare("INSERT INTO budgets VALUES ('global', ?, ?, 0)").run(Math.floor(Date.now()/86_400_000), policy.globalDailyMs);
    await queue.enqueue("a-one", Date.now()); await fire();
    expect(calls.render).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith("thumbnail-deferred", JSON.stringify({ deferred: [{ fileId: "a-one", exhausted: ["global"] }], files: 1 }));
    log.mockRestore();
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
