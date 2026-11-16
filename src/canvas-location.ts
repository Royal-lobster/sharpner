import { useEffect, useRef, useState } from "react";
import type { CanvasNode, Page } from "../shared/types";
import type { Room } from "./room";
import { navigate, useLocation } from "./router";

export type CanvasLocation = { pageId: string | null; selection: string[] };

/** A request to fit nodes, from a link or history traversal. Canvas fits each request object once. */
export type SelectionFocus = { ids: string[] };

const NO_FOCUS: SelectionFocus = { ids: [] };
/** Each request is a new object, so returning to a selection fits it again. Empty requests share one, so local selections leave the editor state alone. */
export const selectionFocusFor = (ids: string[]): SelectionFocus => ids.length ? { ids } : NO_FOCUS;

export function readCanvasLocation(search: string): CanvasLocation {
  const params = new URLSearchParams(search);
  return { pageId: params.get("page") || null, selection: [...new Set(params.getAll("node").filter(Boolean))] };
}

/** Explicit links take precedence over the recipient's remembered page. Node-only links find their page. */
export function resolveCanvasLocation(requested: CanvasLocation, pages: Page[], nodes: ReadonlyMap<string, CanvasNode>, savedPageId: string | null): CanvasLocation {
  let page = pages.find((page) => page.id === requested.pageId);
  if (!page) {
    const linkedNode = requested.selection.map((id) => nodes.get(id)).find((node) => node && pages.some((page) => page.id === node.pageId));
    page = pages.find((page) => page.id === linkedNode?.pageId);
  }
  page ??= (!requested.pageId && !requested.selection.length ? pages.find((page) => page.id === savedPageId) : undefined)
    ?? pages[0];
  return { pageId: page?.id ?? null, selection: requested.selection.filter((id) => page && nodes.get(id)?.pageId === page.id) };
}

/** Works for member URLs and anonymous view links; retains unrelated query parameters and the hash. */
export function canvasLocationUrl(url: URL, view: CanvasLocation): string {
  const next = new URL(url);
  next.searchParams.delete("page");
  next.searchParams.delete("node");
  if (view.pageId) next.searchParams.set("page", view.pageId);
  for (const id of new Set(view.selection)) if (id) next.searchParams.append("node", id);
  return next.pathname + next.search + next.hash;
}

/** The URL owns selection. Local gestures update it without refocusing the camera or filling history. */
export function useCanvasLocation(fileId: string, room: Room) {
  const loc = useLocation();
  const [savedPageId] = useState(() => localStorage.getItem(`sharpner:page:${fileId}`));
  const requested = readCanvasLocation(new URL(loc, location.origin).search);
  const view = resolveCanvasLocation(requested, room.pages, room.nodes, savedPageId);
  const [selectionFocus, setSelectionFocus] = useState(() => selectionFocusFor(requested.selection));
  const observedLocation = useRef(loc);
  const ownNavigation = useRef<string | null>(null);

  const update = (next: CanvasLocation, replace = false) => {
    const to = canvasLocationUrl(new URL(location.href), next);
    if (to === location.pathname + location.search + location.hash) return;
    ownNavigation.current = to.split("#")[0]!;
    navigate(to, { replace });
  };

  useEffect(() => {
    if (observedLocation.current === loc) return;
    observedLocation.current = loc;
    if (ownNavigation.current !== loc) setSelectionFocus(selectionFocusFor(requested.selection));
    ownNavigation.current = null;
  }, [loc]);

  useEffect(() => {
    // Before the first snapshot, a missing page or node is still loading, not a stale link.
    if (room.status === "open" && view.pageId) update(view, true);
  }, [loc, room.status, view.pageId, JSON.stringify(view.selection)]);

  return { ...view, selectionFocus,
    selectPage: (pageId: string) => { setSelectionFocus(NO_FOCUS); update({ pageId, selection: [] }); },
    selectNodes: (selection: string[]) => { setSelectionFocus(NO_FOCUS); update({ pageId: view.pageId, selection }, true); },
    /** Select nodes on this page and fit them, as following a link to them would; Back returns to the previous view. */
    focusNodes: (selection: string[]) => { setSelectionFocus(selectionFocusFor(selection)); update({ pageId: view.pageId, selection }); },
  };
}
