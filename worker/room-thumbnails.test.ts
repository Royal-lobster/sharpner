import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bakeTheme } from "../shared/bake-theme";
import { emptyBrand, type Actor, type NodeInput, type Op, type ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
const renderer = vi.hoisted(() => ({ launch: vi.fn(), loadFrame: vi.fn(), capture: vi.fn(), captureThumbnails: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: renderer.launch } }));
vi.mock("./render", async (original) => ({ ...await original<typeof import("./render")>(), loadFrame: renderer.loadFrame, capture: renderer.capture, captureThumbnails: renderer.captureThumbnails }));
import { darken, FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
beforeEach(() => {
  renderer.launch.mockReset().mockResolvedValue({ newPage: async () => ({}), close: async () => {} });
  renderer.loadFrame.mockReset().mockResolvedValue({ width: 400, height: 600, measured: 600 });
  renderer.capture.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  renderer.captureThumbnails.mockReset().mockResolvedValue({ lo: new Uint8Array([1]), hi: new Uint8Array([2]) });
});
const member: Actor = { id: "alice", name: "Alice", avatar: null };

function fixture(browser = false, sockets: { deserializeAttachment(): unknown }[] = []) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  const statements = { count: 0 };
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    statements.count++;
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
  let pageId = "";
  let viewing = browser;
  const enqueue = vi.fn(async () => {});
  const ctx = { storage, getWebSockets: () => !viewing ? [] : sockets.length ? sockets.map((s) => ({ readyState: 1, deserializeAttachment: () => ({ sessionExpiresAt: Date.now() + 60_000, ...s.deserializeAttachment() as object }) })) : [{ readyState: 1, deserializeAttachment: () => ({ presence: {pageId}, sessionExpiresAt: Date.now() + 60_000 }) }], waitUntil(promise: Promise<unknown>) {
    const settled = promise.catch(() => {});
    pending.add(settled);
    void settled.finally(() => pending.delete(settled));
  } } as unknown as DurableObjectState;
  const env = {
    ...(browser ? { BROWSER: {}, THUMBNAIL_QUEUE: { idFromName: () => "global", get: () => ({ enqueue, acquireScreenshot: async () => "lease", releaseScreenshot: async () => {} }) } } : {}),
    FILES: { put: vi.fn(async () => {}), delete: vi.fn(async () => {}) },
    DB: { prepare: () => ({ bind: () => ({ run: async () => {}, all: async () => ({ results: [] }), first: async () => null }) }) },
  } as unknown as Env;
  const broadcasts: ServerMsg[] = [];
  const wake = () => {
    const room = new FileRoom(ctx, env);
    Object.assign(room, { broadcast: (message: ServerMsg) => broadcasts.push(message) });
    return room;
  };
  const room = wake(); pageId = room.pages()[0]!.id;
  const flush = async () => { while (pending.size) await Promise.all([...pending]); };
  const apply = async (ops: Op[]) => { await room.apply("file", "https://sharpner.example", ops, member); await flush(); };
  const create = (id: string, node: NodeInput = {}) => apply([{ t: "node.put", id, node: { pageId, width: 400, height: 600, source: `<p>${id}</p>`, ...node } }]);
  const cached = () => {
    db.exec("UPDATE nodes SET thumb_rev = rev, thumb_tries = 3, measured_h = 400");
    db.exec(`UPDATE node_thumbnails SET thumb_lo = '/a/file/t/' || node_id || '-' || rev || '-lo.webp', thumb_hi = '/a/file/t/' || node_id || '-' || rev || '-hi.webp', measured_h = 400 WHERE theme = ''`);
  };
  const render = async () => { db.exec("DELETE FROM meta WHERE k = 'thumbAfter'"); const result = await room.renderThumbnails(); await flush(); return result; };
  return { db, statements, room, wake, flush, apply, create, cached, broadcasts, storage, render, enqueue, env, stopViewing: () => { viewing = false; } };
}

describe("thumbnail scheduling", () => {
  it("refreshes thumbnails on pages people are viewing before the rest of the file", async () => {
    const viewer = { presence: { pageId: "viewed", selection: [], cursor: null } };
    const { room, apply, create, cached, broadcasts, render } = fixture(true, [{ deserializeAttachment: () => viewer }]);
    for (let i = 0; i < 30; i++) await create(`elsewhere-${i}`);
    await apply([{ t: "page.put", page: { id: "viewed", name: "Viewed", sort: 2 } }]);
    await apply(["a", "b"].map((id) => ({ t: "node.put", id: `viewed-${id}`, node: { pageId: "viewed", width: 400, height: 600, source: `<p>${id}</p>` } })));
    cached();
    await apply(room.nodes().map((n) => ({ t: "node.put" as const, id: n.id, node: { source: `<p>${n.id} edited</p>` } })));
    renderer.loadFrame.mockClear();
    const before = broadcasts.length;
    await render();
    const rendered = renderer.loadFrame.mock.calls.map(([, node]) => (node as { id: string }).id);
    expect(rendered.slice(0, 2).sort()).toEqual(["viewed-a", "viewed-b"]);
    // Each preview is published as soon as it renders, not once per batch.
    const published = broadcasts.slice(before).map((m) => m.type === "sync" ? m.nodes?.map((n) => n.id) : []);
    expect(published.map((ids) => ids?.[0]).sort()).toEqual([...rendered].sort());
    expect(published.every((ids) => ids?.length === 1)).toBe(true);
    expect(room.node("viewed-a")).toMatchObject({ thumbRev: room.node("viewed-a")!.rev });
  });

  it("ignores a theme sent by an older client and never returns one", async () => {
    const { room, apply, create, broadcasts } = fixture();
    await create("screen");
    const rev = room.node("screen")!.rev;
    await apply([{ t: "node.put", id: "screen", node: { theme: "dark" } as NodeInput }]);
    expect(room.node("screen")).not.toHaveProperty("theme");
    expect(room.node("screen")!.rev).toBe(rev);
    expect(JSON.stringify(broadcasts.at(-1))).not.toContain("theme");
  });

  it("keeps one definition per component tag", async () => {
    const { room, create } = fixture();
    await create("button", { kind: "component", name: "Button/Primary", source: "<button>Go</button>" });
    expect(room.ownDesignSystem().components).toEqual([{ tag: "x-button-primary", html: "<button>Go</button>" }]);
    await expect(create("again", { kind: "component", name: "Button / Primary" })).rejects.toThrow(/already uses the tag/);
  });

  it("keeps one thumbnail per node; a content edit renders again and replaces the row", async () => {
    const {room, apply, create, render, db, env} = fixture(true);
    await create("tokens", {kind:"tokens",source:'[data-theme="dark"]{}'});
    await create("screen");
    await render();
    const initial = room.node("screen")!;
    expect(initial.thumbnails).toHaveProperty("");
    const count = renderer.loadFrame.mock.calls.length;
    await apply([{t:"node.put",id:"screen",node:{source:"<h1>Edited</h1>"}}]);
    expect(room.node("screen")!.thumbRev).toBeLessThan(initial.rev+1);
    await render();
    expect(renderer.loadFrame.mock.calls.slice(count).map(([,n])=>n.id)).toEqual(["screen"]);
    expect(db.prepare("SELECT theme, rev FROM node_thumbnails WHERE node_id = 'screen'").all()).toEqual([{theme:"",rev:initial.rev+1}]);
    expect(env.FILES.delete).toHaveBeenCalled();
  });

  it("renders every node exactly as authored, with no theme input", async () => {
    const { create, render } = fixture(true);
    await create("tokens", { kind: "tokens", source: '@theme { --color-primary: red; } [data-theme="dark"] { --color-primary: blue; }' });
    await create("component", { kind: "component", name: "Button" });
    await create("screen");
    await render();
    for (const [, node] of renderer.loadFrame.mock.calls) expect(node).not.toHaveProperty("theme");
    expect(renderer.loadFrame).toHaveBeenCalledTimes(3);
  });

  it("backfills legacy rows without dropping URLs, or treating an outdated preview as current", async () => {
    const {room, create, db, wake, apply} = fixture();
    await create("screen"); await create("override");
    const rev = room.node("screen")!.rev;
    db.exec(`UPDATE nodes SET thumb_lo='/a/file/t/legacy-lo.webp', thumb_hi='/a/file/t/legacy-hi.webp', thumb_rev=rev, measured_h=720;
      UPDATE nodes SET thumb_rev=0 WHERE id='override';
      DROP TABLE node_thumbnails; ALTER TABLE nodes DROP COLUMN thumb_theme;
      UPDATE meta SET v='8' WHERE k='schema';`);
    const migrated = wake();
    expect(migrated.node("screen")).toMatchObject({rev,thumbHi:"/a/file/t/legacy-hi.webp",thumbTheme:"",measuredHeight:720});
    expect(migrated.node("screen")!.thumbnails![""].rev).toBe(migrated.node("screen")!.rev);
    expect(migrated.node("override")!.thumbRev).toBe(0);
    expect(wake().node("screen")!.thumbnails).toEqual(migrated.node("screen")!.thumbnails);
  });

  it("queues previews that were outdated before the migration, without waiting for an edit", async () => {
    const {room, create, db, wake, flush, enqueue, apply} = fixture(true);
    await create("screen");
    db.exec(`UPDATE nodes SET thumb_lo='/a/file/t/legacy-lo.webp', thumb_hi='/a/file/t/legacy-hi.webp', thumb_rev=rev-1;
      DROP TABLE node_thumbnails; ALTER TABLE nodes DROP COLUMN thumb_theme;
      UPDATE meta SET v='8' WHERE k='schema';`);
    enqueue.mockClear();
    const migrated = wake(); await flush();
    expect(enqueue).toHaveBeenCalled();
    expect(db.prepare("SELECT theme, rev, thumb_lo FROM node_thumbnails WHERE node_id='screen' AND rev=?").all(room.node("screen")!.rev)).toEqual([{theme:"",rev:room.node("screen")!.rev,thumb_lo:null}]);
    expect(migrated.node("screen")!.thumbHi).toBe("/a/file/t/legacy-hi.webp");
  });

  it("ends the session instead of spinning when an edit restarts the debounce mid-render", async () => {
    const {room,create,render} = fixture(true);
    await create("screen");
    renderer.loadFrame.mockImplementationOnce(async () => {
      await create("other");
      return {width:400,height:600,measured:600};
    });
    const started = Date.now();
    expect(await render()).toMatchObject({more:true});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(room.node("other")!.thumbHi).toBeNull();
  });

  it("does not charge a retry to renders aborted by the session", async () => {
    const {create,render,db} = fixture(true);
    await create("screen");
    renderer.loadFrame.mockImplementationOnce(async () => {
      db.exec("INSERT OR REPLACE INTO meta (k, v) VALUES ('designRev', 'changed')");
      throw new Error("Target closed");
    });
    await render();
    expect(db.prepare("SELECT tries FROM node_thumbnails WHERE node_id='screen' AND theme=''").get()).toEqual({tries:0});
  });

  it("never deletes client-supplied image URLs, which may belong to another file", async () => {
    const {create,apply,env} = fixture();
    await create("photo",{kind:"image",src:"/a/other-file/t/photo-1-hi.webp",thumbLo:"/a/other-file/t/photo-1-lo.webp"});
    await apply([{t:"node.del",ids:["photo"]}]);
    expect((env.FILES.delete as ReturnType<typeof vi.fn>).mock.calls.flat(2)).not.toContain("other-file/t/photo-1-lo.webp");
  });

  it("reconciles only edited screens, so an edit costs the same in small and large files", async () => {
    const editCost = async (screens: number) => {
      const {create,apply,statements} = fixture();
      for (let i = 0; i < screens; i++) await create(`screen-${i}`);
      statements.count = 0;
      await apply([{t:"node.put",id:"screen-0",node:{source:"<p>Edited</p>"}}]);
      return statements.count;
    };
    expect(await editCost(60)).toBe(await editCost(5));
  });

  it("still reconciles every screen when tokens change", async () => {
    const {create,apply,db} = fixture();
    const themes = (id: string) => db.prepare("SELECT theme FROM node_thumbnails WHERE node_id = ? ORDER BY theme").all(id).map((r) => r.theme);
    await create("a"); await create("b");
    expect(themes("b")).toEqual([""]);
    db.exec("DELETE FROM node_thumbnails");
    await create("c");
    expect(themes("b")).toEqual([]);
    await create("tokens",{kind:"tokens",source:"@theme {--color-primary:red}"});
    expect(themes("a")).toEqual([""]);
    expect(themes("b")).toEqual([""]);
  });

  it("does no automatic work while nobody is viewing, and coalesces rapid edits", async () => {
    const {room,create,apply,enqueue,stopViewing} = fixture(true);
    await create("screen");
    await apply([{t:"node.put",id:"screen",node:{source:"<p>One</p>"}},{t:"node.put",id:"screen",node:{source:"<p>Two</p>"}}]);
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:true});
    stopViewing(); enqueue.mockClear();
    await apply([{t:"node.put",id:"screen",node:{source:"<p>Latest</p>"}}]);
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:false});
    expect(enqueue).not.toHaveBeenCalled(); expect(renderer.launch).not.toHaveBeenCalled();
  });

  it("drops renders raced by content edits, with capped retries", async () => {
    const {room,create,apply,render,db} = fixture(true);
    await create("screen");
    renderer.loadFrame.mockImplementationOnce(async () => {
      await apply([{t:"node.put",id:"screen",node:{source:"<p>New revision</p>"}}]);
      return {width:400,height:600,measured:600};
    });
    await render();
    expect(room.node("screen")!.thumbHi).toBeNull();
    renderer.loadFrame.mockRejectedValue(new Error("bad frame"));
    await render(); await render(); await render(); await render();
    expect(db.prepare("SELECT tries FROM node_thumbnails WHERE node_id='screen' AND theme=''").get()).toEqual({tries:3});
    expect(renderer.loadFrame).toHaveBeenCalledTimes(4);
  });

  it("shares its browser slot with explicit screenshots", async () => {
    const {room,apply,create,render} = fixture(true);
    await create("tokens",{kind:"tokens",source:'[data-theme="dark"]{}'});
    await create("screen"); await create("override");
    await create("component",{kind:"component",name:"Button"});
    const result = await room.screenshotNodes(["screen","override","tokens","component"],"https://sharpner.example");
    expect(result.content.filter((c)=>c.type==="image")).toHaveLength(4);
    expect(renderer.loadFrame.mock.calls.map(([,n])=>n.id)).toEqual(["screen","override","tokens","component"]);
    let finish!: () => void;
    renderer.loadFrame.mockImplementationOnce(()=>new Promise((resolve)=>{finish=()=>resolve({width:400,height:600,measured:600});}));
    const screenshot = room.screenshotNodes(["screen"],"https://sharpner.example");
    while (!finish) await Promise.resolve();
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:true});
    finish(); await screenshot;
    await render();
    expect(renderer.launch).toHaveBeenCalledTimes(3);
  });
});

describe("theme removal migration", () => {
  const downgrade = (db: DatabaseSync) => db.exec("UPDATE meta SET v = '8' WHERE k = 'schema'");

  it("bakes a screen's theme into its HTML and queues a new thumbnail", async () => {
    const { room, db, wake, create, flush } = fixture(true);
    await create("screen", { source: "<main>Hi</main>" });
    const rev = room.node("screen")!.rev;
    db.exec("UPDATE nodes SET theme = 'dark' WHERE id = 'screen'");
    downgrade(db);
    const migrated = wake(); await flush();
    expect(migrated.node("screen")!.source).toBe(bakeTheme("<main>Hi</main>", "dark"));
    expect(db.prepare("SELECT theme FROM nodes WHERE id = 'screen'").get()).toEqual({ theme: null });
    expect(migrated.node("screen")!.rev).toBe(rev + 1);
    expect(db.prepare("SELECT theme, rev, thumb_lo FROM node_thumbnails WHERE node_id = 'screen'").all()).toEqual([{ theme: "", rev: rev + 1, thumb_lo: null }]);
  });

  it("turns theme overrides into standalone components with unique tags", async () => {
    const { room, db, wake, create } = fixture();
    await create("default", { kind: "component", name: "Button/Primary" });
    await create("taken", { kind: "component", name: "Button/Primary (Dark)" });
    await create("dark", { kind: "component", name: "Temp A" });
    await create("dark2", { kind: "component", name: "Temp B" });
    await create("screen", { source: "<x-button-primary></x-button-primary>" });
    // Overrides can no longer be created through the API; seed legacy rows directly.
    db.exec(`UPDATE nodes SET name = 'Button/Primary', theme = 'dark' WHERE id IN ('dark', 'dark2')`);
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    downgrade(db);
    const migrated = wake();
    expect(migrated.node("default")!.name).toBe("Button/Primary");
    expect(migrated.node("taken")!.name).toBe("Button/Primary (Dark)");
    expect(migrated.node("dark")!.name).toBe("Button/Primary (Dark) 2");
    expect(migrated.node("dark2")!.name).toBe("Button/Primary (Dark) 3");
    expect(db.prepare("SELECT count(*) AS n FROM nodes WHERE theme IS NOT NULL").get()).toEqual({ n: 0 });
    for (const [id, rev] of revs) expect(migrated.node(id)!.rev).toBe(rev + 1);
    expect(db.prepare("SELECT v FROM meta WHERE k = 'designRev'").get()).toBeTruthy();
    expect(new Set(migrated.ownDesignSystem().components.map((c) => c.tag)).size).toBe(4);
  });

  it("is safe to replay", async () => {
    const { room, db, wake, create } = fixture();
    await create("screen", { source: "<main>Hi</main>" });
    await create("button", { kind: "component", name: "Button" });
    await create("dark", { kind: "component", name: "Other" });
    db.exec(`UPDATE nodes SET theme = 'dark' WHERE id IN ('screen', 'dark'); UPDATE nodes SET name = 'Button' WHERE id = 'dark'`);
    downgrade(db);
    const first = wake();
    const snapshot = JSON.stringify([...first.nodes().map((n) => first.node(n.id))]);
    downgrade(db);
    const second = wake();
    expect(JSON.stringify([...second.nodes().map((n) => second.node(n.id))])).toBe(snapshot);
    expect(second.node("dark")!.name).toBe("Button (Dark)");
    expect(room.node("screen")!.source).toBe(bakeTheme("<main>Hi</main>", "dark"));
  });
});

describe("dark-only migration", () => {
  const FRAXNET = "2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a";
  /** Replays the migration as an existing room would see it on its next wake-up. */
  const replay = (db: DatabaseSync, fileId: string) => {
    db.exec(`DELETE FROM meta WHERE k = 'darkSpecimens'; UPDATE meta SET v = '${fileId}' WHERE k = 'fileId'; UPDATE meta SET v = v - 3 WHERE k = 'schema'`);
  };

  it("darkens every screen of a dark-only file and re-renders all its previews", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("fragment", { source: "<main>Hi</main>" });
    await create("baked", { source: `<html data-theme="light" class="light" style="color-scheme:light"><body data-theme="light" class="light"><section data-theme='light'>x</section></body></html>` });
    await create("button", { kind: "component", name: "Button" });
    await create("tokens", { kind: "tokens", source: "@theme { --color-background: white; } .dark { --color-background: black; }" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    replay(db, FRAXNET);
    const migrated = wake(); await flush();
    expect(migrated.node("fragment")!.source).toBe(bakeTheme("<main>Hi</main>", "dark"));
    expect(migrated.node("baked")!.source).toBe(`<html data-theme="dark" class="dark" style="color-scheme:dark"><body data-theme="dark" class="dark"><section data-theme="dark">x</section></body></html>`);
    for (const [id, rev] of revs) {
      expect(migrated.node(id)!.rev).toBe(rev + 1);
      expect(db.prepare("SELECT rev, thumb_lo, tries FROM node_thumbnails WHERE node_id = ? AND theme = ''").get(id)).toEqual({ rev: rev + 1, thumb_lo: null, tries: 0 });
    }
    // Runs once: a later replay of the recorded schema leaves the room alone.
    db.exec("UPDATE meta SET v = v - 3 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });

  it("only refreshes specimen previews in other files and leaves their screens untouched", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    const source = `<html data-theme="light"><body><main>Light</main></body></html>`;
    await create("screen", { source });
    await create("button", { kind: "component", name: "Button" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    replay(db, "file");
    const migrated = wake(); await flush();
    expect(migrated.node("screen")).toMatchObject({ source, rev: revs.get("screen") });
    expect(migrated.node("button")!.rev).toBe(revs.get("button")! + 1);
  });

  it("switches only light theme attributes when darkening", () => {
    expect(darken(`<div data-theme="lightish" data-label="light"><p data-theme=light>a</p></div>`)).toBe(
      `<html data-theme="dark" class="dark" style="color-scheme:dark"><body data-theme="dark" class="dark"><div data-theme="lightish" data-label="light"><p data-theme="dark">a</p></div></body></html>`);
    expect(darken(darken("<p>a</p>"))).toBe(darken("<p>a</p>"));
  });
});

describe("standards-mode migration", () => {
  /** Replays the migration as an existing room would see it on its next wake-up. */
  const replay = (db: DatabaseSync) => {
    db.exec(`DELETE FROM meta WHERE k = 'standardsMode'; UPDATE meta SET v = v - 1 WHERE k = 'schema'`);
  };

  it("re-renders specimens and doctype-less documents that were measured in quirks mode", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("fragment", { source: "<main>Hi</main>" });
    await create("baked", { source: `<html data-theme="dark" class="dark"><body><main>Hi</main></body></html>` });
    await create("indented", { source: `\n  <HTML><body>x</body></HTML>` });
    await create("standards", { source: "<!doctype html><html><body>x</body></html>" });
    await create("button", { kind: "component", name: "Button" });
    await create("tokens", { kind: "tokens", source: "@theme { --color-background: white; } .dark { --color-background: black; }" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    replay(db);
    const migrated = wake(); await flush();
    for (const id of ["baked", "indented", "button", "tokens"]) {
      expect(migrated.node(id)!.rev).toBe(revs.get(id)! + 1);
      expect(db.prepare("SELECT rev, thumb_lo, tries FROM node_thumbnails WHERE node_id = ? AND theme = ''").get(id)).toEqual({ rev: revs.get(id)! + 1, thumb_lo: null, tries: 0 });
    }
    for (const id of ["fragment", "standards"]) expect(migrated.node(id)!.rev).toBe(revs.get(id));
    // Runs once: a later replay of the recorded schema leaves the room alone.
    db.exec("UPDATE meta SET v = v - 1 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });
});

describe("backfill", () => {
  const FRAXNET = "2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a";

  it("renders a backfill file's previews on every page without a viewer, then stops", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 10, 2));
    try {
      const { room, db, wake, apply, create, flush, stopViewing, render } = fixture(true);
      await create("one");
      await apply([{ t: "page.put", page: { id: "other", name: "Other", sort: 2 } }]);
      await apply([{ t: "node.put", id: "two", node: { pageId: "other", width: 400, height: 600, source: "<p>two</p>" } }]);
      stopViewing();
      db.exec(`UPDATE meta SET v = '${FRAXNET}' WHERE k = 'fileId'; UPDATE meta SET v = v - 2 WHERE k = 'schema'`);
      const migrated = wake(); await flush();
      expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toEqual({ v: "1" });
      renderer.loadFrame.mockClear();
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await migrated.renderThumbnails()).toMatchObject({ rendered: 2, more: false });
      expect(renderer.loadFrame.mock.calls.map(([, n]) => (n as { id: string }).id).sort()).toEqual(["one", "two"]);
      expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toEqual({ v: "" });
      // Finished: no viewer means no automatic work again.
      void room; void render;
      await apply([{ t: "node.put", id: "one", node: { source: "<p>edited</p>" } }]);
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await migrated.renderThumbnails()).toMatchObject({ rendered: 0, more: false });
    } finally { vi.useRealTimers(); }
  });

  it("does not mark other files", async () => {
    const { db, wake, create, flush } = fixture(true);
    await create("one");
    db.exec("UPDATE meta SET v = v - 2 WHERE k = 'schema'");
    wake(); await flush();
    expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toBeUndefined();
  });
});

describe("library thumbnail invalidation", () => {
  it("invalidates cached thumbnails when a linked library changes and renders against the new design", async () => {
    const {room,create,apply,render,env} = fixture(true);
    await create("screen"); await render();
    const before=room.node("screen")!;
    let tokens='@theme {--color-primary:blue}';
    Object.assign(env,{
      FILE_ROOM:{idFromName:()=>"library",get:()=>({ownDesignSystem:async()=>({tokens,components:[]}),catalog:async()=>({brand:emptyBrand(),pageId:null,primitives:[],tokenSheets:0})})},
      DB:{prepare:()=>({bind:()=>({first:async()=>({name:"Library"}),all:async()=>({results:[]}),run:async()=>{}})})},
    });
    await room.setLibrary("file","library");
    expect(room.node("screen")!.rev).toBeGreaterThan(before.rev);
    expect(room.node("screen")!.thumbHi).toBe(before.thumbHi);
    await render();
    expect(renderer.loadFrame.mock.calls.at(-1)?.[3].tokens).toContain("blue");
    const linkedRev=room.node("screen")!.rev;
    tokens='@theme {--color-primary:green}';
    await room.libraryChanged(true,[]); await render();
    expect(room.node("screen")!.rev).toBeGreaterThan(linkedRev);
    expect(renderer.loadFrame.mock.calls.at(-1)?.[3].tokens).toContain("green");
  });
});
