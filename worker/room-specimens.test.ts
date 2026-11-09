import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CELL_PAD_X } from "../shared/catalog-specimens";
import type { NodeInput } from "../shared/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class {
    constructor(readonly ctx: DurableObjectState, readonly env: Env) {}
  },
}));

import { FileRoom } from "./room";

const databases: DatabaseSync[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new DatabaseSync(":memory:");
  databases.push(db);
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
  const open = () => new FileRoom({ storage: { sql }, waitUntil: vi.fn() } as unknown as DurableObjectState, {} as Env);
  const room = open();
  const pageId = room.pages()[0]!.id;
  const internals = room as unknown as {
    putNode(id: string, input: NodeInput, touched: Set<string>, design: { tags: Set<string>; tokens: boolean }): boolean;
    refreshSpecimens(): Set<string>;
    putPage(page: { id: string; name: string; sort: number; kind?: "canvas" | "design-system" }): void;
  };
  internals.putPage({ id: pageId, name: "Design System", sort: 0, kind: "design-system" });
  const put = (id: string, input: NodeInput) => internals.putNode(id, { pageId, ...input }, new Set(), { tags: new Set(), tokens: false });
  // apply() runs refreshSpecimens after every batch of operations; the tests call it the same way.
  const refresh = () => [...internals.refreshSpecimens()].sort();
  return { room, put, refresh, internals, db, open };
}

const button = `<button data-size="{{size|md|sm,md,lg}}">{{label|Send}}</button>`;

describe("catalog specimens in the FileRoom", () => {
  it("derives every catalog member's cells from its family and the declared themes, and re-renders them", () => {
    const { room, put, refresh } = fixture();
    put("tokens", { kind: "tokens", source: `[data-theme="dark"] { --color-background: #000 }` });
    put("catalog", { kind: "section" });
    put("primary", { kind: "component", parentId: "catalog", name: "Button/Primary", width: 136, source: button });
    put("ghost", { kind: "component", parentId: "catalog", name: "Button/Ghost", width: 120, source: button.replace("Send", "Ghost") });
    put("loose", { kind: "component", name: "Promo/Banner", source: button });
    const before = room.node("primary")!.rev;
    expect(refresh()).toEqual(["ghost", "primary"]);
    const primary = room.node("primary")!;
    expect(primary.rev).toBe(before + 1);
    expect(primary.specimen).toMatchObject({ cellWidth: 136 + 2 * CELL_PAD_X, axis: "size" });
    expect(primary.specimen!.columns).toHaveLength(6);
    expect(room.node("ghost")!.specimen).toMatchObject({ cellWidth: primary.specimen!.cellWidth });
    // Components outside catalogs keep their single default instance.
    expect(room.node("loose")!.specimen).toBeUndefined();
    // Nothing changed, so nothing renders again.
    expect(refresh()).toEqual([]);
  });

  it("leaves component sections on other pages as they were, so screens kept as components stay their own width", () => {
    const { room, put, refresh, internals } = fixture();
    put("tokens", { kind: "tokens", source: `.dark { --color-background: #000 }` });
    internals.putPage({ id: "feature", name: "Trade", sort: 1 });
    put("parts", { kind: "section", pageId: "feature" });
    put("state", { kind: "component", pageId: "feature", parentId: "parts", name: "Trade/Live", width: 1440, source: "<main>Live</main>" });
    expect(refresh()).toEqual([]);
    expect(room.node("state")!.specimen).toBeUndefined();
  });

  it("re-renders a family's members when one of them widens their shared cells, and keeps cells across edits", () => {
    const { room, put, refresh } = fixture();
    put("catalog", { kind: "section" });
    put("primary", { kind: "component", parentId: "catalog", name: "Button/Primary", width: 136, source: button });
    put("ghost", { kind: "component", parentId: "catalog", name: "Button/Ghost", width: 120, source: button });
    refresh();
    put("primary", { source: button.replace("Send", "Send money") });
    expect(room.node("primary")!.specimen).toBeTruthy();
    expect(refresh()).toEqual([]);
    put("ghost", { width: 200 });
    expect(refresh()).toEqual(["ghost", "primary"]);
    expect(room.node("primary")!.specimen!.cellWidth).toBe(200 + 2 * CELL_PAD_X);
  });

  it("adds a row of cells per value of a family's second listed prop", () => {
    const { room, put, refresh } = fixture();
    put("catalog", { kind: "section" });
    put("primary", { kind: "component", parentId: "catalog", name: "Button/Primary", width: 136, source: button.replace(">", ` data-state="{{state|rest|rest,hover,disabled}}">`) });
    expect(refresh()).toEqual(["primary"]);
    expect(room.node("primary")!.specimen).toMatchObject({ axis: "size", rows: { axis: "state", values: ["rest", "hover", "disabled"] } });
  });

  it("renders every catalog component once more after the theme-class fix, and leaves the rest alone", () => {
    const { room, put, refresh, db, open } = fixture();
    put("tokens", { kind: "tokens", source: `.dark { --color-background: #000 }` });
    put("catalog", { kind: "section" });
    put("primary", { kind: "component", parentId: "catalog", name: "Button/Primary", width: 136, source: button });
    put("loose", { kind: "component", name: "Promo/Banner", source: button });
    refresh();
    const before = { primary: room.node("primary")!.rev, loose: room.node("loose")!.rev };
    db.exec(`DELETE FROM meta WHERE k = 'catalogThemeClass'; UPDATE meta SET v = v - 5 WHERE k = 'schema'`);
    const reopened = open();
    expect(reopened.node("primary")!.rev).toBe(before.primary + 1);
    expect(reopened.node("loose")!.rev).toBe(before.loose);
    expect(db.prepare(`SELECT v FROM meta WHERE k = 'thumbReconcile'`).get()).toEqual({ v: "1" });
    // Guarded: running it again changes nothing.
    db.exec(`UPDATE meta SET v = v - 5 WHERE k = 'schema'`);
    expect(open().node("primary")!.rev).toBe(before.primary + 1);
  });

  it("renders every token sheet once more after nested @theme blocks are read, and leaves the rest alone", () => {
    const { room, put, db, open } = fixture();
    put("tokens", { kind: "tokens", source: `@theme { --text-xl: 20px; @keyframes pop { to { opacity: 1 } } }` });
    put("screen", { kind: "frame", source: "<p>Hi</p>" });
    const before = { tokens: room.node("tokens")!.rev, screen: room.node("screen")!.rev };
    db.exec(`DELETE FROM meta WHERE k = 'nestedThemeTokens'; UPDATE meta SET v = v - 4 WHERE k = 'schema'`);
    const reopened = open();
    expect(reopened.node("tokens")!.rev).toBe(before.tokens + 1);
    expect(reopened.node("screen")!.rev).toBe(before.screen);
  });

  it("renders every token sheet once more as Foundations, once, and leaves the rest alone", () => {
    const { room, put, db, open } = fixture();
    put("tokens", { kind: "tokens", source: `@theme { --color-primary: #d4ff00; --duration-fast: 120ms; }` });
    put("screen", { kind: "frame", source: "<p>Hi</p>" });
    put("primary", { kind: "component", name: "Button/Primary", source: button });
    const before = { tokens: room.node("tokens")!.rev, screen: room.node("screen")!.rev, primary: room.node("primary")!.rev };
    db.exec(`DELETE FROM meta WHERE k IN ('foundationsSheet', 'thumbReconcile'); UPDATE meta SET v = v - 3 WHERE k = 'schema'`);
    const reopened = open();
    expect(reopened.node("tokens")!.rev).toBe(before.tokens + 1);
    expect(reopened.node("screen")!.rev).toBe(before.screen);
    expect(reopened.node("primary")!.rev).toBe(before.primary);
    expect(db.prepare(`SELECT v FROM meta WHERE k = 'thumbReconcile'`).get()).toEqual({ v: "1" });
    // Guarded: running it again changes nothing.
    db.exec(`UPDATE meta SET v = v - 3 WHERE k = 'schema'`);
    expect(open().node("tokens")!.rev).toBe(before.tokens + 1);
  });

  it("renders every scripted frame once more after scripts get time to draw, once, and leaves the rest alone", () => {
    const { room, put, db, open } = fixture();
    put("chart", { kind: "frame", source: "<div data-chart></div><script>requestAnimationFrame(draw)</script>" });
    put("screen", { kind: "frame", source: "<p>Hi</p>" });
    put("tokens", { kind: "tokens", source: `@theme { --color-primary: #d4ff00; }` });
    const before = { chart: room.node("chart")!.rev, screen: room.node("screen")!.rev, tokens: room.node("tokens")!.rev };
    const rewind = () => db.exec(`DELETE FROM meta WHERE k IN ('scriptSettle', 'thumbReconcile'); UPDATE meta SET v = v - 2 WHERE k = 'schema'`);
    rewind();
    let reopened = open();
    expect(reopened.node("chart")!.rev).toBe(before.chart + 1);
    expect(reopened.node("screen")!.rev).toBe(before.screen);
    expect(reopened.node("tokens")!.rev).toBe(before.tokens);
    expect(db.prepare(`SELECT v FROM meta WHERE k = 'thumbReconcile'`).get()).toEqual({ v: "1" });
    // Guarded: running it again changes nothing.
    db.exec(`UPDATE meta SET v = v - 2 WHERE k = 'schema'`);
    expect(open().node("chart")!.rev).toBe(before.chart + 1);
    // A component with a script may be embedded by any frame, so every frame and component renders once more.
    put("runtime", { kind: "component", name: "Chart/Runtime", source: "<script type='text/plain' data-runtime>draw()</script>" });
    const embedded = { screen: open().node("screen")!.rev, runtime: open().node("runtime")!.rev, tokens: open().node("tokens")!.rev };
    rewind();
    reopened = open();
    expect(reopened.node("screen")!.rev).toBe(embedded.screen + 1);
    expect(reopened.node("runtime")!.rev).toBe(embedded.runtime + 1);
    expect(reopened.node("tokens")!.rev).toBe(embedded.tokens);
  });

  it("derives state rows for catalog components once states are inferred, and renders only those again", () => {
    const { room, put, refresh, db, open } = fixture();
    put("catalog", { kind: "section" });
    put("check", { kind: "component", parentId: "catalog", name: "Checkbox/Default", width: 180, source: `<button role="checkbox" aria-checked="false" class="aria-checked:bg-primary disabled:opacity-50"></button>` });
    put("label", { kind: "component", parentId: "catalog", name: "Label/Default", width: 180, source: `<label class="text-sm">{{text|Email}}</label>` });
    refresh();
    // As stored before states were inferred.
    db.exec(`UPDATE nodes SET specimen = NULL WHERE id = 'check'; UPDATE meta SET v = v - 1 WHERE k = 'schema'`);
    const before = { check: room.node("check")!.rev, label: room.node("label")!.rev };
    const reopened = open();
    expect(reopened.node("check")!.specimen!.rows).toEqual({ axis: "state", values: ["", "checked", "disabled", "checked disabled"], inferred: true });
    expect(reopened.node("check")!.rev).toBe(before.check + 1);
    expect(reopened.node("label")!.rev).toBe(before.label);
    expect(db.prepare(`SELECT v FROM meta WHERE k = 'thumbReconcile'`).get()).toEqual({ v: "1" });
  });

  it("stores examples and usage notes on components and validates examples against their props", () => {
    const { room, put } = fixture();
    put("primary", { kind: "component", name: "Button/Primary", source: button, description: "One primary per view." });
    const rev = room.node("primary")!.rev;
    put("primary", { examples: [{ name: "Long label", props: { label: "Send money to Maya" }, width: 160 }] });
    expect(room.node("primary")).toMatchObject({ rev: rev + 1, description: "One primary per view.", examples: [{ name: "Long label", width: 160 }] });
    expect(() => put("primary", { examples: [{ name: "Bad", props: { tone: "x" } }] })).toThrow(/does not declare/);
    put("primary", { examples: null });
    expect(room.node("primary")!.examples).toBeUndefined();
    put("screen", { kind: "frame", source: "<p>Hi</p>" });
    expect(() => put("screen", { examples: [] })).toThrow(/Only components/);
    expect(() => put("screen", { description: "No" })).toThrow(/descriptions/);
  });
});
