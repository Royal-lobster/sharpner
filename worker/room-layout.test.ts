import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { layoutHeight, layoutRects, SECTION_GAP, SECTION_PAD } from "../shared/layout";
import { DESCRIPTION_MAX, type NodeInput, type Page } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: DurableObjectState, readonly env: Env) {}
  },
}));

import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture(legacy = false) {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
  if (legacy) db.exec(`
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    INSERT INTO meta VALUES ('schema', '2');
    CREATE TABLE pages (id TEXT PRIMARY KEY, name TEXT NOT NULL, sort REAL NOT NULL);
    INSERT INTO pages VALUES ('legacy-page', 'Legacy', 0);
    CREATE TABLE nodes (id TEXT PRIMARY KEY, page_id TEXT NOT NULL, parent_id TEXT, kind TEXT NOT NULL,
      name TEXT NOT NULL, x REAL NOT NULL, y REAL NOT NULL, width REAL NOT NULL, height REAL, measured_h REAL,
      src TEXT, thumb_lo TEXT, thumb_hi TEXT, rev INTEGER NOT NULL DEFAULT 1, thumb_rev INTEGER NOT NULL DEFAULT 0,
      thumb_tries INTEGER NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT '');
    INSERT INTO nodes(id,page_id,parent_id,kind,name,x,y,width,height) VALUES
      ('legacy-section','legacy-page',NULL,'section','Legacy',0,0,0,NULL),
      ('legacy-screen','legacy-page','legacy-section','frame','Screen',1000,1200,400,600),
      ('component','legacy-page',NULL,'component','Button',2000,0,400,NULL);
  `);
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    let rows: unknown[];
    if (!args.length && query.includes(";")) { db.exec(query); rows = []; }
    else {
      const statement = db.prepare(query);
      if (statement.columns().length) rows = statement.all(...args);
      else { statement.run(...args); rows = []; }
    }
    return { toArray: () => rows, [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } };
  const wake = () => new FileRoom({ storage: { sql }, waitUntil: vi.fn() } as unknown as DurableObjectState, {} as Env);
  const room = wake();
  const pageId = room.pages()[0]!.id;
  // Exercise the production SQLite write path directly; apply's network fan-out is independent of layout.
  const put = (id: string, input: NodeInput) => (room as unknown as {
    putNode(id: string, input: NodeInput, touched: Set<string>, design: { tags: Set<string>; tokens: boolean }): boolean;
  }).putNode(id, { pageId, ...input }, new Set(), { tags: new Set(), tokens: false });
  const putPage = (page: Page) => (room as unknown as { putPage(page: Page): void }).putPage(page);
  const rects = () => layoutRects(room.nodes(), layoutHeight);
  return { db, room, wake, put, putPage, rects, pageId };
}

describe("persisted automatic layout", () => {
  it("stores new sections as automatic and keeps creation order across edits", () => {
    const { db, room, put, rects } = fixture();
    put("flow", { kind: "section" });
    put("first", { parentId: "flow", source: "<p>First</p>" });
    put("second", { parentId: "flow", source: "<p>Second</p>" });
    const before = rects();
    put("first", { name: "Renamed", source: "<p>Updated</p>" });
    // An older deployment reads this column, so a rollback still arranges the section.
    expect(db.prepare("SELECT layout FROM nodes WHERE id = 'flow'").get()).toEqual({ layout: "auto" });
    expect(rects()).toEqual(before);
    expect(room.nodes().map((n) => n.id)).toEqual(["flow", "first", "second"]);
    expect(room.node("first")!.order).toBeLessThan(room.node("second")!.order!);
  });

  it("migrates legacy sections to automatic layout, keeps their stored positions, and refreshes specimen previews", () => {
    const { room, rects, db } = fixture(true);
    expect(db.prepare("SELECT layout FROM nodes WHERE id = 'legacy-section'").get()).toEqual({ layout: "auto" });
    expect(db.prepare("SELECT v FROM meta WHERE k = 'freeSections'").get()).toEqual({ v: '["legacy-section"]' });
    expect(room.node("legacy-screen")).toMatchObject({ x: 1000, y: 1200 });
    expect(rects().get("legacy-section")).toMatchObject({ x: 0, y: 0 });
    expect(rects().get("legacy-screen")).toMatchObject({ x: SECTION_PAD, y: SECTION_PAD });
    // Seven specimen refreshes: the old card presentation, dark specimens, standards-mode measurement, compact specimens twice,
    // the owner's clear, then full-width previews.
    expect(room.node("component")!.rev).toBe(8);
    expect(db.prepare("SELECT v FROM meta WHERE k = 'schema'").get()).toEqual({ v: "29" });
  });

  it("refreshes cached token previews once for named themes without rerendering screens or components", () => {
    const { db, wake, put } = fixture();
    const source = '@theme { --color-primary: #112233; } [data-theme="uwu"] { --color-primary: #eeaaff; }';
    put("tokens", { kind: "tokens", source });
    put("button", { kind: "component", name: "Button", source: "<button>Continue</button>" });
    put("screen", { source: "<x-button></x-button>" });
    db.exec("UPDATE nodes SET thumb_rev = rev, thumb_tries = 3, measured_h = 400; UPDATE meta SET v = '6' WHERE k = 'schema';");

    const upgraded = wake();
    expect(upgraded.node("tokens")).toMatchObject({ rev: 2, measuredHeight: null, source });
    expect(db.prepare("SELECT thumb_rev, thumb_tries FROM nodes WHERE id = 'tokens'").get())
      .toEqual({ thumb_rev: 1, thumb_tries: 0 });
    for (const id of ["button", "screen"]) {
      expect(upgraded.node(id)).toMatchObject({ rev: 1, measuredHeight: 400 });
      expect(db.prepare("SELECT thumb_rev, thumb_tries FROM nodes WHERE id = ?").get(id))
        .toEqual({ thumb_rev: 1, thumb_tries: 3 });
    }
    expect(wake().node("tokens")!.rev).toBe(2);
  });

  it("makes free sections automatic once, so sections placed by hand no longer overlap", () => {
    const { db, wake, put, rects } = fixture();
    put("dark", { kind: "section" });
    put("dark-screen", { parentId: "dark", source: "<p>Dark</p>", width: 1440, height: 900 });
    put("light", { kind: "section" });
    put("light-screen", { parentId: "light", source: "<p>Light</p>", width: 1440, height: 900 });
    // An agent placed both sections by hand, one over the other, before every section was automatic.
    db.exec(`UPDATE nodes SET layout = 'free' WHERE kind = 'section'; UPDATE nodes SET x = 0, y = 0;
      DELETE FROM meta WHERE k = 'freeSections'; UPDATE meta SET v = '16' WHERE k = 'schema';`);
    const upgraded = wake();
    expect(db.prepare("SELECT v FROM meta WHERE k = 'freeSections'").get()).toEqual({ v: '["dark","light"]' });
    expect(db.prepare("SELECT DISTINCT layout FROM nodes WHERE kind = 'section'").all()).toEqual([{ layout: "auto" }]);
    const after = layoutRects(upgraded.nodes(), layoutHeight), dark = after.get("dark")!, light = after.get("light")!;
    expect(light).toMatchObject({ x: dark.x + dark.w + SECTION_GAP, y: dark.y });
    expect(rects()).toEqual(after);

    // The list records the sections the first run changed; running again changes nothing.
    db.exec(`UPDATE meta SET v = '16' WHERE k = 'schema';`);
    wake();
    expect(db.prepare("SELECT v FROM meta WHERE k = 'freeSections'").get()).toEqual({ v: '["dark","light"]' });
  });

  it("makes free sections automatic in a file that recorded schema 17 while the compact-specimen migration held that slot", () => {
    const { db, wake, put } = fixture();
    put("dark", { kind: "section" });
    // A deploy briefly ran compact specimens as migration 17, so these files recorded 17 without the free-section pass.
    db.exec(`UPDATE nodes SET layout = 'free' WHERE kind = 'section';
      DELETE FROM meta WHERE k = 'freeSections'; INSERT OR REPLACE INTO meta (k, v) VALUES ('compactSpecimens', '1');
      UPDATE meta SET v = '17' WHERE k = 'schema';`);
    wake();
    expect(db.prepare("SELECT v FROM meta WHERE k = 'freeSections'").get()).toEqual({ v: '["dark"]' });
    expect(db.prepare("SELECT DISTINCT layout FROM nodes WHERE kind = 'section'").all()).toEqual([{ layout: "auto" }]);
  });

  it("moves a screen out of its section into the page's arrangement without storing a position", () => {
    const { room, put, rects } = fixture();
    put("flow", { kind: "section" });
    put("screen", { parentId: "flow", source: "<p>Screen</p>" });
    const flow = rects().get("flow")!;
    put("screen", { parentId: null });
    expect(room.node("screen")).toMatchObject({ parentId: null, x: 0, y: 0 });
    expect(rects().get("screen")).toMatchObject({ x: 0, y: rects().get("flow")!.h + SECTION_GAP });
    expect(rects().get("flow")!.h).toBeLessThan(flow.h);
  });

  it("rejects invalid managed metadata instead of persisting it", () => {
    const { put } = fixture();
    put("flow", { kind: "section" });
    expect(() => put("flow", { order: Infinity })).toThrow("finite");
  });
});

describe("page and section descriptions", () => {
  it("stores a page description, keeps it through a rename without one, and clears it when emptied", () => {
    const { room, putPage } = fixture();
    putPage({ id: "ds", name: "Design System", sort: 1, description: "  Tokens and component catalogs.  " });
    expect(room.pages().find((p) => p.id === "ds")).toEqual({ id: "ds", name: "Design System", sort: 1, description: "Tokens and component catalogs." });
    putPage({ id: "ds", name: "Foundations", sort: 1 });
    expect(room.pages().find((p) => p.id === "ds")).toMatchObject({ name: "Foundations", description: "Tokens and component catalogs." });
    putPage({ id: "ds", name: "Foundations", sort: 1, description: "x".repeat(DESCRIPTION_MAX + 50) });
    expect(room.pages().find((p) => p.id === "ds")!.description).toHaveLength(DESCRIPTION_MAX);
    putPage({ id: "ds", name: "Foundations", sort: 1, description: "" });
    expect(room.pages().find((p) => p.id === "ds")!.description).toBe("");
    putPage({ id: "new", name: "Screens", sort: 2 });
    expect(room.pages().find((p) => p.id === "new")!.description).toBe("");
  });

  it("describes sections only, keeps the text across edits, and omits empty descriptions from node metadata", () => {
    const { room, put } = fixture();
    put("forms", { kind: "section", name: "Forms", description: "Inputs, selects and validation states." });
    put("forms", { name: "Forms & Inputs", order: 5 });
    expect(room.node("forms")).toMatchObject({ name: "Forms & Inputs", description: "Inputs, selects and validation states." });
    put("screen", { parentId: "forms", source: "<p>Field</p>" });
    expect(room.nodes(["screen"])[0]).not.toHaveProperty("description");
    expect(() => put("screen", { description: "A screen" })).toThrow("sections");
    put("forms", { description: "" });
    expect(room.nodes(["forms"])[0]).not.toHaveProperty("description");
  });

  it("keeps descriptions when an older deployment lowers the recorded migration version", () => {
    const { db, wake, put, putPage, pageId } = fixture();
    putPage({ id: pageId, name: "Page 1", sort: 0, description: "Everything so far." });
    put("flow", { kind: "section", description: "Sign-up flow." });
    db.prepare("UPDATE meta SET v = '5' WHERE k = 'schema'").run();
    const recovered = wake();
    expect(recovered.pages()[0]!.description).toBe("Everything so far.");
    expect(recovered.node("flow")!.description).toBe("Sign-up flow.");
  });

  it("removes a section's or page's description with it", () => {
    const { db, room, put, putPage } = fixture();
    putPage({ id: "flows", name: "Flows", sort: 1, description: "Flows." });
    put("flow", { kind: "section", pageId: "flows", description: "Sign-up flow." });
    put("other", { kind: "section", description: "Stays." });
    (room as unknown as { deleteNode(id: string, stale: string[], design: object, deleted: Set<string>): void })
      .deleteNode("flow", [], { tags: new Set(), tokens: false }, new Set());
    expect(db.prepare("SELECT id FROM descriptions ORDER BY id").all()).toEqual([{ id: "flows" }, { id: "other" }]);
  });

  it("migrates existing pages and sections as undescribed", () => {
    const { room } = fixture(true);
    expect(room.pages()).toEqual([{ id: "legacy-page", name: "Legacy", sort: 0, description: "" }]);
    expect(room.node("legacy-section")).not.toHaveProperty("description");
  });
});

describe("component instances", () => {
  it("finds exact tags once per using frame or component", () => {
    const { room, put, pageId } = fixture();
    put("button", { kind: "component", name: "Button", source: "<button><slot></slot></button>" });
    put("primary", { kind: "component", name: "Button/Primary", source: "<x-button>Go</x-button>" });
    put("screen", { name: "Checkout", source: '<main><X-Button-Primary label="Pay"></X-Button-Primary><x-button>A</x-button><x-button/></main>' });
    put("plain", { source: "<p>x-button is mentioned, not used</p>" });
    expect(room.instances()).toEqual([
      { tag: "x-button", id: "primary", name: "Button/Primary", kind: "component", pageId },
      { tag: "x-button-primary", id: "screen", name: "Checkout", kind: "frame", pageId },
      { tag: "x-button", id: "screen", name: "Checkout", kind: "frame", pageId },
    ]);
  });
});
