import type { CanvasNode } from "../shared/types";

/** One row of the active page's outline in the pages popover: a section and what it holds, or one design. */
export type OutlineItem =
  | { kind: "section"; node: CanvasNode; /** Designs inside it, at any depth. */ count: number; open: boolean; children: OutlineItem[] }
  | { kind: "design"; node: CanvasNode; selected: boolean };

/**
 * The active page's sections as a tree, in canvas order. A section is open when the viewer opened it, or,
 * until they toggle it, when it holds the selection. With no selection the first section opens, so the popover
 * always shows some screens. Only open sections list their contents. `nodes` is the page as this viewer sees it.
 */
export function pageOutline(nodes: readonly CanvasNode[], { selection, toggled }: { selection: readonly string[]; toggled: ReadonlyMap<string, boolean> }): OutlineItem[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const index = new Map(nodes.map((n, i) => [n.id, n.order ?? i]));
  const kids = new Map<string | null, CanvasNode[]>();
  for (const n of nodes) {
    // A node whose section is gone (or hidden) sits at the top level, as the layout places it.
    const parent = n.parentId && byId.has(n.parentId) ? n.parentId : null;
    (kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(n);
  }
  for (const list of kids.values()) list.sort((a, b) => index.get(a.id)! - index.get(b.id)! || a.id.localeCompare(b.id));

  const selected = new Set(selection);
  const holdsSelection = new Set<string>();
  for (const id of selected) {
    let parent = byId.get(id)?.parentId;
    while (parent && byId.has(parent) && !holdsSelection.has(parent)) {
      holdsSelection.add(parent);
      parent = byId.get(parent)!.parentId;
    }
  }
  const firstSection = holdsSelection.size ? undefined : kids.get(null)?.find((n) => n.kind === "section")?.id;

  const build = (parent: string | null): { items: OutlineItem[]; count: number } => {
    const items: OutlineItem[] = [];
    let count = 0;
    for (const node of kids.get(parent) ?? []) {
      if (node.kind !== "section") {
        count++;
        items.push({ kind: "design", node, selected: selected.has(node.id) });
        continue;
      }
      const inner = build(node.id);
      count += inner.count;
      const open = toggled.get(node.id) ?? (holdsSelection.has(node.id) || node.id === firstSection);
      items.push({ kind: "section", node, count: inner.count, open, children: open ? inner.items : [] });
    }
    return { items, count };
  };
  return build(null).items;
}
