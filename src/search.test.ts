import { describe, expect, it } from "vitest";
import type { FileSummary } from "./api";
import type { CanvasNode, Page } from "../shared/types";
import { fileMatches, searchPages } from "./search";

const file = (id: string, name: string, library_id: string | null = null): FileSummary =>
  ({ id, name, cover: null, library_id, used_by: 0, created_at: 0, updated_at: 0 });

describe("fileMatches", () => {
  const acme = file("acme", "Acme Design System");
  const checkout = file("checkout", "Checkout flow", "acme");
  const notes = file("notes", "Release notes");
  const files = [acme, checkout, notes];
  const names = new Map(files.map((f) => [f.id, f.name]));
  const find = (query: string) => files.filter((f) => fileMatches(f, query, names)).map((f) => f.id);

  it("matches every file for an empty or blank query", () => {
    expect(find("")).toEqual(["acme", "checkout", "notes"]);
    expect(find("   ")).toEqual(["acme", "checkout", "notes"]);
  });
  it("matches a file name, ignoring case and accents", () => {
    expect(find("CHECKOUT")).toEqual(["checkout"]);
    expect(find("relèase")).toEqual(["notes"]);
  });
  it("matches the name of the library a file uses", () => {
    expect(find("acme")).toEqual(["acme", "checkout"]);
  });
  it("matches a file name and its library name together, in any order", () => {
    expect(find("checkout acme")).toEqual(["checkout"]);
    expect(find("acme flow")).toEqual(["checkout"]);
    expect(find("notes acme")).toEqual([]);
  });
  it("does not match a library that is no longer listed", () => {
    expect(fileMatches(file("orphan", "Orphan", "gone"), "gone", names)).toBe(false);
  });
});

describe("searchPages", () => {
  const pages: Page[] = [
    { id: "cover", name: "Cover", sort: 0 },
    { id: "flows", name: "Flows", sort: 1, description: "Checkout and onboarding screens" },
    { id: "ds", name: "Design System", sort: 2, kind: "design-system" },
  ];
  const section = (id: string, pageId: string, name: string): CanvasNode => ({
    id, pageId, parentId: null, kind: "section", name, x: 0, y: 0,
    width: 400, height: 600, measuredHeight: null, src: null, thumbLo: null, thumbHi: null, rev: 1,
  });
  const nodes: CanvasNode[] = [
    section("s1", "flows", "Checkout"), section("s2", "flows", "Onboarding"), section("s3", "ds", "Buttons"),
    { ...section("f1", "ds", "Checkout button"), kind: "frame" },
  ];
  const nodesOf = (pageId: string) => nodes.filter((n) => n.pageId === pageId);
  const find = (query: string) => searchPages(pages, query, nodesOf).map(({ page, sections }) => ({ [page.id]: sections }));

  it("lists every page, in file order, for an empty query", () => {
    expect(find(" ")).toEqual([{ cover: [] }, { flows: [] }, { ds: [] }]);
  });
  it("matches a page by name or description", () => {
    expect(find("design")).toEqual([{ ds: [] }]);
    expect(find("onboarding screens")).toEqual([{ flows: [] }]);
  });
  it("matches a page through its sections, and names them", () => {
    expect(find("buttons")).toEqual([{ ds: ["Buttons"] }]);
    expect(find("checkout")).toEqual([{ flows: ["Checkout"] }]);
  });
  it("matches only sections, not other designs", () => {
    expect(find("checkout button")).toEqual([]);
  });
});
