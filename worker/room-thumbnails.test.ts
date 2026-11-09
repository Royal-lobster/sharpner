import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bakeTheme } from "../shared/bake-theme";
import { emptyBrand, type Actor, type NodeInput, type Op, type ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
const renderer = vi.hoisted(() => ({ launch: vi.fn(), connect: vi.fn(), loadFrame: vi.fn(), loadImagePreview: vi.fn(), capture: vi.fn(), captureThumbnails: vi.fn(), renderSprite: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: renderer.launch, connect: renderer.connect } }));
vi.mock("./render", async (original) => ({ ...await original<typeof import("./render")>(), loadFrame: renderer.loadFrame, loadImagePreview: renderer.loadImagePreview, capture: renderer.capture, captureThumbnails: renderer.captureThumbnails }));
vi.mock("./render-sprite", async (original) => ({ ...await original<typeof import("./render-sprite")>(), renderSprite: renderer.renderSprite }));
/** A sprite renders its nodes the way single renders do, so the loadFrame mock sees every node either way. */
async function spriteOfSingles(tab: unknown, jobs: { id: string }[], base: string, design: unknown) {
  const captured = new Map<string, unknown>();
  for (const n of jobs) {
    const size = await renderer.loadFrame(tab, n, base, design);
    captured.set(n.id, { ...size, ...await renderer.captureThumbnails(tab, size.width, size.height) });
  }
  return { captured, fallback: [], phases: { load: 0, settle: 0, capture: 0, encode: 0 } };
}
import { darken, FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
beforeEach(() => {
  renderer.launch.mockReset().mockResolvedValue({ newPage: async () => ({}), close: async () => {} });
  renderer.loadFrame.mockReset().mockResolvedValue({ width: 400, height: 600, measured: 600 });
  renderer.loadImagePreview.mockReset().mockResolvedValue({ width: 800, height: 600 });
  renderer.capture.mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  renderer.captureThumbnails.mockReset().mockResolvedValue({ lo: new Uint8Array([1]), hi: new Uint8Array([2]) });
  renderer.renderSprite.mockReset().mockImplementation(spriteOfSingles);
  renderer.connect.mockReset();
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
    const sprites = renderer.renderSprite.mock.calls.map(([, jobs]) => (jobs as { id: string }[]).map((n) => n.id));
    expect(sprites[0]!.slice(0, 2)).toEqual(["viewed-a", "viewed-b"]);
    // Each sprite's previews are published as soon as it renders, not once per batch or turn.
    const published = broadcasts.slice(before).map((m) => m.type === "sync" ? m.nodes!.map((n) => n.id) : []);
    // Sprites finish in any order, so compare the sets of nodes published together.
    const together = (groups: string[][]) => groups.map((ids) => [...ids].sort().join(",")).sort();
    expect(together(published)).toEqual(together(sprites));
    expect(published.flat().sort()).toEqual(renderer.loadFrame.mock.calls.map(([, node]) => (node as { id: string }).id).sort());
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

  it("deletes only an image's own earlier preview when it renders, never an object its src names", async () => {
    const {create,apply,render,env,db} = fixture(true);
    const deleted = () => (env.FILES.delete as ReturnType<typeof vi.fn>).mock.calls.flat(2);
    await create("photo",{kind:"image",src:"/a/other-file/t/screen-3-abc-hi.webp"});
    await render();
    expect(db.prepare("SELECT thumb_lo FROM nodes WHERE id='photo'").get()).toEqual({thumb_lo:"/a/file/t/photo-1-lo.webp"});
    await apply([{t:"node.put",id:"photo",node:{src:"/a/other-file/t/screen-4-def-hi.webp"}}]);
    await render();
    expect(db.prepare("SELECT thumb_lo FROM nodes WHERE id='photo'").get()).toEqual({thumb_lo:"/a/file/t/photo-2-lo.webp"});
    expect(deleted().filter((key: string) => key.startsWith("other-file/"))).toEqual([]);
  });

  it("ignores a late partial put for a deleted node instead of recreating it", async () => {
    const {create,apply,room,db} = fixture();
    await create("screen");
    await apply([{t:"node.del",ids:["screen"]}]);
    await apply([{t:"node.put",id:"screen",node:{name:"Late rename"}}]);
    expect(room.node("screen")).toBeFalsy();
    expect(db.prepare("SELECT COUNT(*) AS n FROM nodes").get()).toEqual({n:0});
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

  it("renders an agent's edit while nobody is viewing, and coalesces rapid edits", async () => {
    const {room,create,apply,enqueue,stopViewing,db} = fixture(true);
    await create("screen");
    await apply([{t:"node.put",id:"screen",node:{source:"<p>One</p>"}},{t:"node.put",id:"screen",node:{source:"<p>Two</p>"}}]);
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:true});
    stopViewing(); enqueue.mockClear();
    await apply([{t:"node.put",id:"screen",node:{source:"<p>Latest</p>"}}]);
    expect(enqueue).toHaveBeenCalled();
    db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
    expect(await room.renderThumbnails()).toMatchObject({rendered:1,more:false});
    expect(renderer.loadFrame.mock.calls.at(-1)![1]).toMatchObject({id:"screen",html:expect.stringContaining("Latest")});
  });

  it("renders the first edit after a quiet spell at once, and waits out a burst", async () => {
    const {room,create,apply,enqueue} = fixture(true);
    await create("screen");
    // The screen was created long ago; nothing has changed since.
    room["setMeta"]("thumbEditAt", String(Date.now() - 5000));
    enqueue.mockClear();
    await apply([{t:"node.put",id:"screen",node:{source:"<p>Quiet edit</p>"}}]);
    const [, readyAt] = enqueue.mock.calls.at(-1)! as unknown as [string, number];
    expect(readyAt).toBeLessThanOrEqual(Date.now());
    expect(await room.renderThumbnails()).toMatchObject({rendered:1,more:false});
    // A second edit right after the first waits for the burst to pause.
    await apply([{t:"node.put",id:"screen",node:{source:"<p>Burst edit</p>"}}]);
    expect((enqueue.mock.calls.at(-1)! as unknown as [string, number])[1]).toBeGreaterThan(Date.now() + 1000);
    expect(await room.renderThumbnails()).toMatchObject({rendered:0,more:true});
  });

  it("re-renders a screen that uses a component an agent edited, with nobody viewing", async () => {
    const {room,create,apply,stopViewing,db,render} = fixture(true);
    await create("button",{kind:"component",name:"Button",source:"<button>Old</button>"});
    await create("screen",{source:"<main><x-button></x-button></main>"});
    await render();
    const before = room.node("screen")!.rev;
    stopViewing(); renderer.loadFrame.mockClear();
    await apply([{t:"node.put",id:"button",node:{source:"<button>New</button>"}}]);
    expect(room.node("screen")!.rev).toBe(before + 1);
    db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
    expect(await room.renderThumbnails()).toMatchObject({rendered:2});
    expect(renderer.loadFrame.mock.calls.map(([,n])=>n.id).sort()).toEqual(["button","screen"]);
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
    await render(); await render(); await render(); await render(); await render();
    expect(db.prepare("SELECT tries FROM node_thumbnails WHERE node_id='screen' AND theme=''").get()).toEqual({tries:3});
    // The raced render, the sprite that failed (free: the node then renders alone) and three charged single renders.
    expect(renderer.loadFrame).toHaveBeenCalledTimes(5);
    expect(renderer.renderSprite).toHaveBeenCalledTimes(2);
  });

  it("keeps rendering other previews through a component edit, and renders the affected ones against the new design", async () => {
    const {room,create,apply,render} = fixture(true);
    await create("button",{kind:"component",name:"Button",source:"<button>Old</button>"});
    await create("uses",{source:"<main><x-button></x-button></main>"});
    await create("plain",{source:"<p>No components</p>"});
    let edited = false;
    renderer.renderSprite.mockImplementation(async (tab, jobs, base, design) => {
      const result = await spriteOfSingles(tab, jobs, base, design);
      if (!edited) {
        edited = true;
        await apply([{t:"node.put",id:"button",node:{source:"<button>New</button>"}}]);
        // That edit's debounce would end the turn; this test is about the design change.
        room["setMeta"]("thumbAfter", "0");
      }
      return result;
    });
    await render();
    for (const id of ["button","uses","plain"]) expect(room.node(id)).toMatchObject({thumbRev:room.node(id)!.rev});
    const renders = renderer.loadFrame.mock.calls.map(([,n,,design]) => ({id:(n as {id:string}).id,html:(design as {components:{html:string}[]}).components[0]!.html}));
    // The unaffected screen rendered once; the button and its user rendered again in the same turn, with the new definition.
    expect(renders.filter((r) => r.id === "plain")).toHaveLength(1);
    for (const id of ["button","uses"]) expect(renders.filter((r) => r.id === id).at(-1)!.html).toBe("<button>New</button>");
  });

  it("renders a node alone once it falls back from a sprite", async () => {
    const {room,create,render} = fixture(true);
    await create("grows",{height:null}); await create("calm"); await create("other");
    renderer.renderSprite.mockImplementation(async (tab, jobs: {id:string}[], base, design) => ({
      ...await spriteOfSingles(tab, jobs.filter((n) => n.id !== "grows"), base, design),
      fallback: jobs.some((n) => n.id === "grows") ? ["grows"] : [],
    }));
    await render();
    for (const id of ["grows","calm","other"]) expect(room.node(id)).toMatchObject({thumbRev:room.node(id)!.rev});
    // Offered to a sprite once; then rendered on its own page in the same turn.
    expect(renderer.renderSprite.mock.calls.filter(([,jobs]) => (jobs as {id:string}[]).some((n) => n.id === "grows"))).toHaveLength(1);
    expect(renderer.loadFrame.mock.calls.filter(([,n]) => (n as {id:string}).id === "grows")).toHaveLength(1);
  });

  it("ends the session without charging a retry when a sprite fails, then renders its nodes alone", async () => {
    const {room,create,render,db} = fixture(true);
    await create("a"); await create("b");
    renderer.renderSprite.mockRejectedValueOnce(new Error("sprite timed out")).mockRejectedValueOnce(new Error("sprite timed out"));
    expect(await render()).toMatchObject({rendered:0,more:true});
    expect(db.prepare("SELECT node_id, tries FROM node_thumbnails ORDER BY node_id").all()).toEqual([{node_id:"a",tries:0},{node_id:"b",tries:0}]);
    renderer.renderSprite.mockClear(); renderer.loadFrame.mockClear();
    await render();
    for (const id of ["a","b"]) expect(room.node(id)).toMatchObject({thumbRev:room.node(id)!.rev});
    // Both sprites failed, so both nodes render on their own pages, never in a sprite again.
    expect(renderer.renderSprite).not.toHaveBeenCalled();
    expect(renderer.loadFrame.mock.calls.map(([,n])=>(n as {id:string}).id).sort()).toEqual(["a","b"]);
  });

  describe("warm browser", () => {
    function session(id: string) {
      const pages: { close: ReturnType<typeof vi.fn> }[] = [];
      const browser = { newPage: vi.fn(async () => { const page = { close: vi.fn(async () => {}) }; pages.push(page); return page; }),
        close: vi.fn(async () => {}), disconnect: vi.fn(async () => {}), sessionId: () => id };
      return { browser, pages };
    }

    it("leaves its browser running when another file is waiting, and the next turn reconnects instead of launching", async () => {
      const {room,create,apply,db} = fixture(true);
      const {browser, pages} = session("warm-1");
      renderer.launch.mockResolvedValue(browser); renderer.connect.mockResolvedValue(browser);
      await create("screen");
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await room.renderThumbnails(undefined, undefined, undefined, true)).toMatchObject({rendered:1,warm:"warm-1"});
      // Its own pages close; the browser stays.
      expect(pages.map((p) => p.close.mock.calls.length)).toEqual([1]);
      expect(browser.disconnect).toHaveBeenCalledTimes(1);
      expect(browser.close).not.toHaveBeenCalled();
      await apply([{t:"node.put",id:"screen",node:{source:"<p>Edited</p>"}}]);
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await room.renderThumbnails(undefined, undefined, "warm-1", true)).toMatchObject({rendered:1,warm:"warm-1"});
      expect(renderer.connect).toHaveBeenCalledWith(expect.anything(), "warm-1");
      expect(renderer.launch).toHaveBeenCalledTimes(1);
    });

    it("closes its browser, even one it reconnected to, when nothing else is due", async () => {
      const {room,create,db} = fixture(true);
      const {browser, pages} = session("warm-1");
      renderer.connect.mockResolvedValue(browser);
      await create("screen");
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await room.renderThumbnails(undefined, undefined, "warm-1")).toMatchObject({rendered:1,warm:null});
      expect(renderer.connect).toHaveBeenCalledWith(expect.anything(), "warm-1");
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.disconnect).not.toHaveBeenCalled();
      expect(pages).toHaveLength(1);
    });

    it("keeps its browser for the file's own remaining previews", async () => {
      const {room,create,db} = fixture(true);
      const {browser} = session("warm-1");
      renderer.launch.mockResolvedValue(browser);
      await create("a"); await create("b");
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      // The fair turn ends before any render, so both previews are left for the next turn.
      expect(await room.renderThumbnails(undefined, 0)).toMatchObject({rendered:0,more:true,warm:"warm-1"});
      expect(browser.close).not.toHaveBeenCalled();
      expect(browser.disconnect).toHaveBeenCalledTimes(1);
    });

    it("launches when the warm browser is gone, and closes a browser that had a failed sprite", async () => {
      const {room,create,db} = fixture(true);
      const {browser} = session("fresh");
      renderer.connect.mockRejectedValue(new Error("session closed"));
      renderer.launch.mockResolvedValue(browser);
      renderer.renderSprite.mockRejectedValueOnce(new Error("sprite timed out"));
      await create("screen");
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await room.renderThumbnails(undefined, undefined, "gone", true)).toMatchObject({rendered:0,warm:null});
      expect(renderer.launch).toHaveBeenCalledTimes(1);
      expect(browser.close).toHaveBeenCalledTimes(1);
      expect(browser.disconnect).not.toHaveBeenCalled();
    });

    it("opens each tab in a browser context of its own and closes those contexts, keeping the browser", async () => {
      const {room,create,db} = fixture(true);
      const contexts: { newPage: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[] = [];
      const shared = {};
      const browser = { ...session("ctx").browser, defaultBrowserContext: () => shared,
        createBrowserContext: vi.fn(async () => {
          const context = { close: vi.fn(async () => {}), newPage: vi.fn(async () => ({ close: vi.fn(async () => {}), browserContext: () => context })) };
          contexts.push(context);
          return context;
        }) };
      renderer.launch.mockResolvedValue(browser);
      await create("a"); await create("b"); await create("c");
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await room.renderThumbnails(undefined, undefined, undefined, true)).toMatchObject({rendered:3,warm:"ctx"});
      expect(contexts).toHaveLength(3);
      expect(contexts.map((c) => c.close.mock.calls.length)).toEqual([1, 1, 1]);
      expect(browser.newPage).not.toHaveBeenCalled();
      expect(browser.disconnect).toHaveBeenCalledTimes(1);
    });

    it("reports no browser when the turn had nothing to render", async () => {
      const {room} = fixture(true);
      expect((await room.renderThumbnails(undefined, undefined, "warm-1")).warm).toBeUndefined();
      expect(renderer.connect).not.toHaveBeenCalled();
    });
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
    db.exec(`DELETE FROM meta WHERE k = 'darkSpecimens'; UPDATE meta SET v = '${fileId}' WHERE k = 'fileId'; UPDATE meta SET v = v - 18 WHERE k = 'schema'`);
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
    db.exec("UPDATE meta SET v = v - 18 WHERE k = 'schema'");
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
    db.exec(`DELETE FROM meta WHERE k = 'standardsMode'; UPDATE meta SET v = v - 16 WHERE k = 'schema'`);
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
    db.exec("UPDATE meta SET v = v - 16 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });
});

describe("compact specimen migration", () => {
  it("re-renders every component once, leaving screens and token sheets alone", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("screen", { source: "<main>Hi</main>" });
    await create("button", { kind: "component", name: "Button/Primary" });
    await create("tokens", { kind: "tokens", source: "@theme { --color-background: white; }" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    db.exec(`DELETE FROM meta WHERE k = 'compactSpecimens'; UPDATE meta SET v = v - 13 WHERE k = 'schema'`);
    const migrated = wake(); await flush();
    expect(migrated.node("button")!.rev).toBe(revs.get("button")! + 1);
    expect(db.prepare("SELECT rev, thumb_lo, tries FROM node_thumbnails WHERE node_id = 'button' AND theme = ''").get()).toEqual({ rev: revs.get("button")! + 1, thumb_lo: null, tries: 0 });
    for (const id of ["screen", "tokens"]) expect(migrated.node(id)!.rev).toBe(revs.get(id));
    // Runs once: a later replay of the recorded schema leaves the room alone.
    db.exec("UPDATE meta SET v = v - 13 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });
});

describe("second compact specimen migration", () => {
  it("re-renders every component once more, so previews rendered by an older release get the compact specimen", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("screen", { source: "<main>Hi</main>" });
    await create("button", { kind: "component", name: "Button/Primary" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    // The file already ran the first compact migration; only the repeat is new.
    db.exec(`DELETE FROM meta WHERE k = 'compactSpecimensAgain'; UPDATE meta SET v = v - 11 WHERE k = 'schema'`);
    const migrated = wake(); await flush();
    expect(migrated.node("button")!.rev).toBe(revs.get("button")! + 1);
    expect(db.prepare("SELECT rev, thumb_lo, tries FROM node_thumbnails WHERE node_id = 'button' AND theme = ''").get()).toEqual({ rev: revs.get("button")! + 1, thumb_lo: null, tries: 0 });
    expect(migrated.node("screen")!.rev).toBe(revs.get("screen"));
    db.exec("UPDATE meta SET v = v - 11 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });
});

describe("component preview clear", () => {
  it("re-renders every component once and restarts a backfill file's backfill", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("screen", { source: "<main>Hi</main>" });
    await create("button", { kind: "component", name: "Button/Primary" });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    db.exec(`DELETE FROM meta WHERE k = 'componentPreviewsCleared'; UPDATE meta SET v = v - 10 WHERE k = 'schema'`);
    const migrated = wake(); await flush();
    expect(migrated.node("button")!.rev).toBe(revs.get("button")! + 1);
    expect(migrated.node("screen")!.rev).toBe(revs.get("screen"));
    db.exec("UPDATE meta SET v = v - 10 WHERE k = 'schema'");
    expect(wake().node("button")!.rev).toBe(revs.get("button")! + 1);
  });
});

describe("full preview refresh", () => {
  it("re-renders every frame, component and token sheet once in the listed files only", async () => {
    for (const [fileId, bumped] of [["2f86e75c-5e8a-4a4d-a5a6-5a065a943e4a", 1], ["other-file", 0]] as const) {
      const { room, db, wake, create, cached, flush } = fixture(true);
      await create("screen", { source: "<main>Hi</main>" });
      await create("button", { kind: "component", name: "Button/Primary" });
      await create("tokens", { kind: "tokens", source: "@theme { --color-background: white; }" });
      cached();
      const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
      db.exec(`DELETE FROM meta WHERE k = 'previewsRefreshed'; UPDATE meta SET v = '${fileId}' WHERE k = 'fileId'; UPDATE meta SET v = v - 9 WHERE k = 'schema'`);
      const migrated = wake(); await flush();
      for (const id of ["screen", "button", "tokens"]) expect(migrated.node(id)!.rev).toBe(revs.get(id)! + bumped);
      db.exec("UPDATE meta SET v = v - 9 WHERE k = 'schema'");
      for (const id of ["screen", "button", "tokens"]) expect(wake().node(id)!.rev).toBe(revs.get(id)! + bumped);
    }
  });
});

describe("full-width preview migration", () => {
  it("re-renders every component and each auto-height frame whose layout can depend on the viewport height, once", async () => {
    const { room, db, wake, create, cached, flush } = fixture(true);
    await create("button", { kind: "component", name: "Button/Primary", source: "<button>Go</button>" });
    await create("bar", { kind: "component", name: "Trade/Bar", source: '<div class="fixed bottom-0">Buy</div>' });
    await create("card", { kind: "component", name: "Card/Plain", source: "<section>Card</section>" });
    await create("tokens", { kind: "tokens", source: "@theme { --color-background: white; }" });
    // A fixed bar inside a component, a sheet sized in vh, a sticky footer and a library component the room cannot read.
    await create("uses-bar", { height: null, source: "<main><x-trade-bar></x-trade-bar></main>" });
    await create("sheet", { height: null, source: '<main><div class="max-h-[88vh]">Sheet</div></main>' });
    await create("footer", { height: null, source: '<main><footer style="position: sticky; bottom: 0">Total</footer></main>' });
    await create("uses-library", { height: null, source: "<main><x-from-library></x-from-library></main>" });
    // None can move: plain flow content, a page with a viewport minimum height, a header that sticks to the top,
    // and a fixed-height frame whose viewport is its own height.
    await create("plain", { height: null, source: "<main><x-card-plain></x-card-plain></main>" });
    await create("page", { height: null, source: '<main class="min-h-screen w-screen">Hi</main>' });
    await create("header", { height: null, source: '<header class="sticky top-0">Nav</header><main>Hi</main>' });
    await create("phone", { height: 844, source: '<main><div class="fixed bottom-0">Buy</div></main>' });
    cached();
    const revs = new Map(room.nodes().map((n) => [n.id, n.rev]));
    db.exec(`DELETE FROM meta WHERE k = 'fullWidthPreviews'; UPDATE meta SET v = v - 8 WHERE k = 'schema'`);
    const migrated = wake(); await flush();
    const bumped = ["button", "bar", "card", "uses-bar", "sheet", "footer", "uses-library"];
    for (const n of migrated.nodes()) expect([n.id, n.rev]).toEqual([n.id, revs.get(n.id)! + (bumped.includes(n.id) ? 1 : 0)]);
    expect(db.prepare("SELECT rev, thumb_lo, tries FROM node_thumbnails WHERE node_id = 'uses-bar' AND theme = ''").get()).toEqual({ rev: revs.get("uses-bar")! + 1, thumb_lo: null, tries: 0 });
    db.exec("UPDATE meta SET v = v - 8 WHERE k = 'schema'");
    for (const n of wake().nodes()) expect(n.rev).toBe(revs.get(n.id)! + (bumped.includes(n.id) ? 1 : 0));
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
      db.exec(`UPDATE meta SET v = '${FRAXNET}' WHERE k = 'fileId'; UPDATE meta SET v = v - 17 WHERE k = 'schema'`);
      const migrated = wake(); await flush();
      expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toEqual({ v: "1" });
      renderer.loadFrame.mockClear();
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await migrated.renderThumbnails()).toMatchObject({ rendered: 2, more: false });
      expect(renderer.loadFrame.mock.calls.map(([, n]) => (n as { id: string }).id).sort()).toEqual(["one", "two"]);
      expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toEqual({ v: "" });
      // Finished: a later edit still renders without a viewer, like any file's.
      void room; void render;
      await apply([{ t: "node.put", id: "one", node: { source: "<p>edited</p>" } }]);
      db.exec("DELETE FROM meta WHERE k = 'thumbAfter'");
      expect(await migrated.renderThumbnails()).toMatchObject({ rendered: 1, more: false });
    } finally { vi.useRealTimers(); }
  });

  it("starts again once to render the standards-mode re-renders without a viewer", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(Date.UTC(2026, 10, 2));
    try {
      const { db, wake, create, flush } = fixture(true);
      await create("one");
      // The original backfill already finished before the standards-mode migration queued its re-renders.
      db.exec(`UPDATE meta SET v = '${FRAXNET}' WHERE k = 'fileId'; INSERT OR REPLACE INTO meta (k, v) VALUES ('backfill', ''); UPDATE meta SET v = v - 15 WHERE k = 'schema'`);
      wake(); await flush();
      expect(db.prepare("SELECT v FROM meta WHERE k = 'backfill'").get()).toEqual({ v: "1" });
    } finally { vi.useRealTimers(); }
  });

  it("does not mark other files", async () => {
    const { db, wake, create, flush } = fixture(true);
    await create("one");
    db.exec("UPDATE meta SET v = v - 17 WHERE k = 'schema'");
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
