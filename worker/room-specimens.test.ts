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
  const room = new FileRoom({ storage: { sql }, waitUntil: vi.fn() } as unknown as DurableObjectState, {} as Env);
  const pageId = room.pages()[0]!.id;
  const internals = room as unknown as {
    putNode(id: string, input: NodeInput, touched: Set<string>, design: { tags: Set<string>; tokens: boolean }): boolean;
    refreshSpecimens(): Set<string>;
  };
  const put = (id: string, input: NodeInput) => internals.putNode(id, { pageId, ...input }, new Set(), { tags: new Set(), tokens: false });
  // apply() runs refreshSpecimens after every batch of operations; the tests call it the same way.
  const refresh = () => [...internals.refreshSpecimens()].sort();
  return { room, put, refresh };
}

const button = `<button data-size="{{size|md|sm,md,lg}}">{{label|Send}}</button>`;

describe("catalog specimens in the FileRoom", () => {
  it("derives every catalog member's cells from its family and the declared themes, and re-renders them", () => {
    const { room, put, refresh } = fixture();
    put("tokens", { kind: "tokens", source: `[data-theme="dark"] { --color-background: #000 }` });
    put("catalog", { kind: "section" });
    put("primary", { kind: "component", parentId: "catalog", name: "Button/Primary", width: 136, source: button });
    put("ghost", { kind: "component", parentId: "catalog", name: "Button/Ghost", width: 120, source: `<button>{{label|Ghost}}</button>` });
    put("loose", { kind: "component", name: "Promo/Banner", source: button });
    const before = room.node("primary")!.rev;
    expect(refresh()).toEqual(["ghost", "primary"]);
    const primary = room.node("primary")!;
    expect(primary.rev).toBe(before + 1);
    expect(primary.specimen).toMatchObject({ cellWidth: 136 + 2 * CELL_PAD_X, axis: "size" });
    expect(primary.specimen!.columns).toHaveLength(6);
    expect(room.node("ghost")!.specimen).toMatchObject({ cellWidth: primary.specimen!.cellWidth, blank: [0, 2, 3, 5] });
    // Components outside catalogs keep their single default instance.
    expect(room.node("loose")!.specimen).toBeUndefined();
    // Nothing changed, so nothing renders again.
    expect(refresh()).toEqual([]);
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
