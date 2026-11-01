import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyBrand, type Actor, type NodeInput, type Op, type ServerMsg } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(readonly ctx: DurableObjectState, readonly env: Env) {} },
}));
const renderer = vi.hoisted(() => ({ launch: vi.fn(), loadFrame: vi.fn(), capture: vi.fn(), captureThumbnails: vi.fn() }));
vi.mock("@cloudflare/puppeteer", () => ({ default: { launch: renderer.launch } }));
vi.mock("./render", async (original) => ({ ...await original<typeof import("./render")>(), loadFrame: renderer.loadFrame, capture: renderer.capture, captureThumbnails: renderer.captureThumbnails }));
import { FileRoom } from "./room";

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
    db.exec(`UPDATE node_thumbnails SET thumb_lo = '/a/file/t/' || node_id || '-' || rev || '-lo.webp', thumb_hi = '/a/file/t/' || node_id || '-' || rev || '-hi.webp', measured_h = 400
      WHERE theme = CASE WHEN (SELECT kind FROM nodes WHERE id = node_id) = 'tokens' THEN '' ELSE coalesce((SELECT theme FROM nodes WHERE id = node_id), (SELECT nullif(v, '') FROM meta WHERE k = 'fileTheme'), '') END`);
  };
  const render = async () => { db.exec("DELETE FROM meta WHERE k = 'thumbAfter'"); const result = await room.renderThumbnails(); await flush(); return result; };
  return { db, statements, room, wake, flush, apply, create, cached, broadcasts, storage, render, enqueue, env, stopViewing: () => { viewing = false; } };
}

describe("file and screen themes", () => {
  it("persists a file default and screen overrides across hibernation without rewriting sources", async () => {
    const { room, wake, apply, create, broadcasts } = fixture();
    await create("screen", { source: '<main class="dark">Screen</main>' });
    await create("override", { theme: "uwu" });
    expect(room.theme()).toBeNull();
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.theme()).toBe("dark");
    expect(room.node("screen")!.source).toBe('<main class="dark">Screen</main>');
    expect(room.node("override")!.theme).toBe("uwu");
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", fileTheme: "dark" });
    const restored = wake();
    expect(restored.theme()).toBe("dark");
    expect(restored.node("override")!.theme).toBe("uwu");
    await apply([{ t: "theme.set", theme: null }]);
    expect(room.theme()).toBeNull();
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", fileTheme: null });
  });

  it("selects inheriting screens without invalidating their content or explicit overrides", async () => {
    const { db, room, apply, create, cached, broadcasts, enqueue } = fixture(true);
    await create("tokens", { kind: "tokens", source: '@theme { --color-primary: red; } [data-theme="dark"] { --color-primary: blue; }' });
    await create("component", { kind: "component", name: "Button" });
    await create("screen");
    await create("override", { theme: "light" });
    await create("section", { kind: "section" });
    await create("image", { kind: "image", src: "/a/file/original.png", thumbLo: "/a/file/preview.webp" });
    cached();
    const before = new Map(room.nodes().map((n) => [n.id, n.rev]));
    enqueue.mockClear();
    await apply([{ t: "theme.set", theme: "dark" }]);
    for (const id of ["screen", "component"]) {
      // The previous measurement holds the layout until the restyled thumbnail measures again.
      expect(room.node(id)).toMatchObject({ rev: before.get(id), thumbRev: 0, measuredHeight: 400 });
      expect(db.prepare("SELECT tries FROM node_thumbnails WHERE node_id = ? AND theme = 'dark'").get(id)).toEqual({ tries: 0 });
    }
    for (const id of ["tokens", "override", "section", "image"]) {
      expect(room.node(id)).toMatchObject({ rev: before.get(id), measuredHeight: 400 });
    }
    expect(enqueue).toHaveBeenCalled();
    expect(broadcasts.at(-1)).toMatchObject({ type: "sync", nodes: expect.arrayContaining([expect.objectContaining({ id: "screen" }), expect.objectContaining({ id: "component" })]) });
    const rev = room.node("screen")!.rev;
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.node("screen")!.rev).toBe(rev);
  });

  it("refreshes thumbnails on pages people are viewing before the rest of the file", async () => {
    const viewer = { presence: { pageId: "viewed", selection: [], cursor: null } };
    const { room, apply, create, cached, broadcasts, render } = fixture(true, [{ deserializeAttachment: () => viewer }]);
    for (let i = 0; i < 30; i++) await create(`elsewhere-${i}`);
    await apply([{ t: "page.put", page: { id: "viewed", name: "Viewed", sort: 2 } }]);
    await apply(["a", "b"].map((id) => ({ t: "node.put", id: `viewed-${id}`, node: { pageId: "viewed", width: 400, height: 600, source: `<p>${id}</p>` } })));
    cached();
    await apply([{ t: "theme.set", theme: "dark" }]);
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

  it("lets a component carry one override per theme, used by its instances' screens", async () => {
    const { room, apply, create, cached } = fixture();
    await create("button", { kind: "component", name: "Button/Primary", source: "<button>Go</button>" });
    await create("sakura-button", { kind: "component", name: "Button/Primary", theme: "sakura", source: "<button class=petals>Go</button>" });
    await create("screen", { source: "<x-button-primary></x-button-primary>" });
    expect(room.ownDesignSystem().components).toEqual([
      { tag: "x-button-primary", html: "<button>Go</button>", theme: null },
      { tag: "x-button-primary", html: "<button class=petals>Go</button>", theme: "sakura" },
    ]);
    // A second default, or a second override for the same theme, is still a tag clash.
    await expect(create("again", { kind: "component", name: "Button / Primary" })).rejects.toThrow(/already uses the tag/);
    await expect(create("again", { kind: "component", name: "Button/Primary", theme: "sakura" })).rejects.toThrow(/already overrides <x-button-primary> for the sakura theme/);
    await create("uwu-button", { kind: "component", name: "Button/Primary", theme: "uwu", source: "<button>uwu</button>" });

    cached();
    const screen = room.node("screen")!.rev, override = room.node("sakura-button")!.rev;
    // Restructuring an override re-renders the screens using the component.
    await apply([{ t: "node.put", id: "sakura-button", node: { source: "<button class=petals>Go!</button>" } }]);
    expect(room.node("screen")!.rev).toBe(screen + 1);
    // A file theme change re-renders inheriting nodes, not overrides that always show their own theme.
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.node("sakura-button")!.rev).toBe(override + 1);
    expect(room.node("button")!.rev).toBe(1);
    expect(room.node("screen")!.rev).toBe(screen + 1);
  });

  it("keeps an override through unrelated edits and resumes inheritance when cleared", async () => {
    const { room, apply, create, cached } = fixture();
    await create("screen");
    await apply([{ t: "theme.set", theme: "dark" }]);
    cached();
    const original = room.node("screen")!;
    await apply([{ t: "node.put", id: "screen", node: { theme: " light " } }]);
    expect(room.node("screen")).toMatchObject({ theme: "light", rev: original.rev, measuredHeight: 400, source: original.source });
    await apply([{ t: "node.put", id: "screen", node: { name: "Renamed" } }, { t: "theme.set", theme: "uwu" }]);
    expect(room.node("screen")).toMatchObject({ theme: "light", rev: original.rev });
    await apply([{ t: "node.put", id: "screen", node: { theme: null } }]);
    expect(room.node("screen")!.theme ?? null).toBeNull();
    expect(room.node("screen")!.rev).toBe(original.rev);
    await apply([{ t: "theme.set", theme: "dark" }]);
    expect(room.node("screen")!.rev).toBe(original.rev);
  });

  it("rolls back malformed themes and overrides on unsupported node kinds", async () => {
    const { room, apply, create } = fixture();
    await create("screen");
    await create("tokens", { kind: "tokens", source: "@theme { --color-primary: red; }" });
    await apply([{ t: "theme.set", theme: "dark" }]);
    const rev = room.node("screen")!.rev;
    for (const theme of ["", "   ", "x".repeat(81), 42, undefined]) {
      await expect(apply([{ t: "node.put", id: "partial", node: {} }, { t: "theme.set", theme } as Op])).rejects.toThrow(/theme/i);
      expect(room.node("partial")).toBeNull();
      expect(room.theme()).toBe("dark");
      expect(room.node("screen")!.rev).toBe(rev);
    }
    // Token sheets compare every theme, so they never take one.
    await expect(apply([{ t: "theme.set", theme: "light" }, { t: "node.put", id: "tokens", node: { theme: "dark" } }])).rejects.toThrow(/screens and components/i);
    expect(room.theme()).toBe("dark");
    expect(room.node("tokens")!.theme ?? null).toBeNull();
  });

  it("renders cached previews with the same effective theme as live screens, leaving token comparisons intact", async () => {
    const { room, apply, create, render } = fixture(true);
    await create("tokens", { kind: "tokens", source: '@theme { --color-primary: red; } [data-theme="dark"] { --color-primary: blue; }' });
    await create("component", { kind: "component", name: "Button" });
    await create("screen");
    await create("override", { theme: "uwu" });
    await apply([{ t: "theme.set", theme: "dark" }]);
    await render();
    const renders = new Map<string, string | undefined>();
    for (const [, node] of renderer.loadFrame.mock.calls) if (!renders.has(node.id)) renders.set(node.id, node.theme);
    expect(renders).toEqual(new Map([["tokens", undefined], ["component", "dark"], ["screen", "dark"], ["override", "uwu"]]));
  });
});

describe("content/theme thumbnail pairs", () => {
  it("reuses both directions without rendering, and warms only themes selected at least once", async () => {
    const { room, apply, create, render } = fixture(true);
    await create("tokens", {kind:"tokens",source:'@theme {--color-primary:red} [data-theme="dark"]{} [data-theme="uwu"]{}'});
    await create("screen");
    await apply([{t:"theme.set",theme:"light"}]);
    await render();
    const initial = room.node("screen")!;
    expect(initial.thumbnails).toHaveProperty("light");
    expect(initial.thumbnails).not.toHaveProperty("dark");
    expect(initial.thumbnails).not.toHaveProperty("uwu");
    await apply([{t:"theme.set",theme:"dark"}]); await render();
    const dark = room.node("screen")!;
    expect(dark.rev).toBe(initial.rev);
    expect(dark.thumbHi).not.toBe(initial.thumbHi);
    const count = renderer.loadFrame.mock.calls.length;
    for (const theme of ["light", "dark", "light"]) {
      await apply([{t:"theme.set",theme}]); await render();
      expect(room.node("screen")!.thumbRev).toBe(initial.rev);
    }
    expect(renderer.loadFrame).toHaveBeenCalledTimes(count);
    expect(room.node("screen")!.thumbHi).toBe(initial.thumbHi);
  });

  it("invalidates every cached theme on content edits; current viewed pages render before warm themes", async () => {
    const {room, apply, create, render, db, env} = fixture(true);
    await create("tokens", {kind:"tokens",source:'[data-theme="dark"]{}'});
    await create("screen");
    await apply([{t:"theme.set",theme:"light"}]); await render();
    await apply([{t:"theme.set",theme:"dark"}]); await render();
    const before = room.node("screen")!, count = renderer.loadFrame.mock.calls.length;
    await apply([{t:"node.put",id:"screen",node:{source:"<h1>Edited</h1>"}}]);
    expect(room.node("screen")!.rev).toBe(before.rev+1);
    expect(room.node("screen")!.thumbRev).toBeLessThan(before.rev+1);
    await render();
    const jobs = renderer.loadFrame.mock.calls.slice(count).map(([,n])=>[n.id,n.theme]);
    expect(jobs[0]).toEqual(["screen","dark"]);
    expect(jobs).toContainEqual(["screen","light"]);
    expect(db.prepare("SELECT DISTINCT rev FROM node_thumbnails WHERE node_id = 'screen'").all()).toEqual([{rev:before.rev+1}]);
    expect(env.FILES.delete).toHaveBeenCalled();
  });

  it("backfills legacy rows without dropping URLs, or treating an outdated preview as current", async () => {
    const {room, create, db, wake, apply} = fixture();
    await create("screen"); await create("override",{theme:"light"});
    await apply([{t:"theme.set",theme:"dark"}]);
    const rev = room.node("screen")!.rev;
    db.exec(`UPDATE nodes SET thumb_lo='/a/file/t/legacy-lo.webp', thumb_hi='/a/file/t/legacy-hi.webp', thumb_rev=rev, measured_h=720;
      UPDATE nodes SET thumb_rev=0 WHERE id='override';
      DROP TABLE node_thumbnails; DROP TABLE used_themes; ALTER TABLE nodes DROP COLUMN thumb_theme;
      UPDATE meta SET v='8' WHERE k='schema';`);
    const migrated = wake();
    expect(migrated.node("screen")).toMatchObject({rev,thumbHi:"/a/file/t/legacy-hi.webp",thumbTheme:"dark",measuredHeight:720});
    expect(migrated.node("screen")!.thumbnails!.dark.rev).toBe(migrated.node("screen")!.rev);
    expect(migrated.node("override")!.thumbRev).toBe(0);
    expect(wake().node("screen")!.thumbnails).toEqual(migrated.node("screen")!.thumbnails);
  });

  it("queues previews that were outdated before the migration, without waiting for an edit", async () => {
    const {room, create, db, wake, flush, enqueue, apply} = fixture(true);
    await create("screen");
    await apply([{t:"theme.set",theme:"dark"}]);
    db.exec(`UPDATE nodes SET thumb_lo='/a/file/t/legacy-lo.webp', thumb_hi='/a/file/t/legacy-hi.webp', thumb_rev=rev-1;
      DROP TABLE node_thumbnails; DROP TABLE used_themes; ALTER TABLE nodes DROP COLUMN thumb_theme;
      UPDATE meta SET v='8' WHERE k='schema';`);
    enqueue.mockClear();
    const migrated = wake(); await flush();
    expect(enqueue).toHaveBeenCalled();
    expect(db.prepare("SELECT theme, rev, thumb_lo FROM node_thumbnails WHERE node_id='screen' AND rev=?").all(room.node("screen")!.rev)).toEqual([{theme:"dark",rev:room.node("screen")!.rev,thumb_lo:null}]);
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

  it("still reconciles every screen when the file theme or a new override theme changes", async () => {
    const {create,apply,db} = fixture();
    const themes = (id: string) => db.prepare("SELECT theme FROM node_thumbnails WHERE node_id = ? ORDER BY theme").all(id).map((r) => r.theme);
    await create("a"); await create("b");
    await apply([{t:"theme.set",theme:"dark"}]);
    expect(themes("b")).toEqual(["", "dark"]);
    db.exec("DELETE FROM node_thumbnails WHERE node_id = 'b'");
    await create("c",{theme:"light"});
    expect(themes("b")).toEqual(["", "dark", "light"]);
  });

  it("does no automatic work while nobody is viewing, and coalesces rapid edits and toggles", async () => {
    const {room,create,apply,enqueue,stopViewing} = fixture(true);
    await create("screen");
    await apply([{t:"theme.set",theme:"dark"},{t:"theme.set",theme:"light"}]);
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:true});
    stopViewing(); enqueue.mockClear();
    await apply([{t:"node.put",id:"screen",node:{source:"<p>Latest</p>"}}]);
    expect(await room.renderThumbnails()).toMatchObject({browserMs:0,rendered:0,more:false});
    expect(enqueue).not.toHaveBeenCalled(); expect(renderer.launch).not.toHaveBeenCalled();
  });

  it("drops renders raced by content edits, with separate capped retries for each pair", async () => {
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

  it("shares its browser slot with explicit screenshots and preserves effective themes", async () => {
    const {room,apply,create,render} = fixture(true);
    await create("tokens",{kind:"tokens",source:'[data-theme="dark"]{}'});
    await create("screen"); await create("override",{theme:"light"});
    await create("component",{kind:"component",name:"Button",theme:"uwu"});
    await apply([{t:"theme.set",theme:"dark"}]);
    const result = await room.screenshotNodes(["screen","override","tokens","component"],"https://sharpner.example");
    expect(result.content.filter((c)=>c.type==="image")).toHaveLength(4);
    expect(renderer.loadFrame.mock.calls.map(([,n])=>[n.id,n.theme])).toEqual([["screen","dark"],["override","light"],["tokens",undefined],["component","uwu"]]);
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

describe("library thumbnail invalidation", () => {
  it("invalidates cached themes when a linked library changes and renders against the new design", async () => {
    const {room,create,apply,render,env} = fixture(true);
    await create("screen"); await apply([{t:"theme.set",theme:"dark"}]); await render();
    const before=room.node("screen")!;
    let tokens='@theme {--color-primary:blue} [data-theme="dark"]{}';
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
    tokens='@theme {--color-primary:green} [data-theme="dark"]{}';
    await room.libraryChanged(true,[]); await render();
    expect(room.node("screen")!.rev).toBeGreaterThan(linkedRev);
    expect(renderer.loadFrame.mock.calls.at(-1)?.[3].tokens).toContain("green");
  });
});
