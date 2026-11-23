import type { FileSummary } from "./api";
import type { CanvasNode, Page } from "../shared/types";

/** Case- and accent-insensitive text a query is compared against. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** The query's words. Each must appear somewhere in what is searched, in any order. */
const terms = (query: string) => fold(query).split(/\s+/).filter(Boolean);

const matchesAll = (words: string[], haystack: string) => words.every((w) => haystack.includes(w));

/**
 * Whether a file matches a workspace home search. A query matches the file's name, the name of the
 * library it uses, or both: "acme checkout" finds a Checkout file that uses the Acme library.
 * An empty query matches every file. `names` maps file IDs to names, to resolve the library.
 */
export function fileMatches(file: FileSummary, query: string, names: ReadonlyMap<string, string>) {
  const words = terms(query);
  if (!words.length) return true;
  const library = file.library_id ? names.get(file.library_id) ?? "" : "";
  return matchesAll(words, fold(`${file.name}\n${library}`));
}

/** A page that matches a pages search, and the names of its sections that match on their own. */
export type PageMatch = { page: Page; sections: string[] };

/**
 * The pages a pages-panel search finds, in file order. A page matches on its name or description, or when one of
 * its sections is named for the query; those sections are listed so the member sees why the page matched.
 * An empty query matches every page, with no sections listed.
 */
export function searchPages(pages: readonly Page[], query: string, nodesOf: (pageId: string) => readonly CanvasNode[]): PageMatch[] {
  const words = terms(query);
  if (!words.length) return pages.map((page) => ({ page, sections: [] }));
  const out: PageMatch[] = [];
  for (const page of pages) {
    const own = matchesAll(words, fold(`${page.name}\n${page.description ?? ""}`));
    const sections = nodesOf(page.id).filter((n) => n.kind === "section" && matchesAll(words, fold(n.name))).map((n) => n.name);
    if (own || sections.length) out.push({ page, sections });
  }
  return out;
}
