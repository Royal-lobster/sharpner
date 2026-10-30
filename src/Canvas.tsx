import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { CATALOG_GUTTER, CATALOG_ROW_GAP, catalogFamilyLabels, catalogSectionIds, contains, descendantsOf, dropOrders, familyOf, isManaged, layoutRects, SECTION_PAD, union, type Rect } from "../shared/layout";
import { frameDocument, renderedHtml, type CanvasNode, type CommentAnchor, type CommentThread, type DesignSystem, type Op } from "../shared/types";
import { commentPoint } from "../shared/comments";
import { componentName } from "../shared/specimens";
import { colorFor, uploadImage } from "./api";
import { toast } from "./toast";
import { ThumbnailCache, thumbnailSource } from "./thumbnail-cache";
import { applyTouch, TouchNavigator } from "./touch-gestures";
import { canvasGestureBoundary } from "./canvas-gesture-boundary";
import type { Room } from "./room";
import { HI_RES_MIN_PIXELS, planCanvasRendering, type Camera as Cam, type ProjectedNode } from "./canvas-render-plan";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { IconLayout, IconMaximize, IconMinus, IconPlus } from "@tabler/icons-react";
import { usePreviewPrefetch } from "./hooks/use-preview-prefetch";
import { canvasNavigation, MAX_CANVAS_ZOOM } from "./canvas-navigation";

type Tier = "lo" | "hi";

/** Below this on-screen section padding, labels of nested nodes would collide with the section title. */
const NESTED_LABEL_GAP = 24;
/** How long a newly appeared node takes to rack-focus in. */
const MATERIALIZE_MS = 700;
/** How long the focus-lock plays when an agent finishes with a node. */
const LOCK_MS = 700;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const camKey = (pageId: string) => `sharpner:cam:${pageId}`;

type Props = {
  room: Room;
  fileId: string;
  pageId: string;
  selection: string[];
  onSelect: (ids: string[]) => void;
  /** Link viewers can look around but never select, move, delete, or add anything. */
  readOnly?: boolean;
  commentMode?: boolean;
  activeCommentId?: string | null;
  commentFocus?: { id: string; request: number } | null;
  onPlaceComment?: (anchor: CommentAnchor) => void;
  onOpenComment?: (thread: CommentThread) => void;
  draftComment?: CommentAnchor | null;
};

export function Canvas({ room, fileId, pageId, selection, onSelect, readOnly = false, commentMode = false, activeCommentId, commentFocus, onPlaceComment, onOpenComment, draftComment }: Props) {
  useSyncExternalStore(room.subscribe, room.getVersion);
  const rootRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  const saved = useMemo(() => {
    try {
      return JSON.parse(localStorage.getItem(camKey(pageId)) ?? "null") as Cam | null;
    } catch {
      return null;
    }
  }, [pageId]);
  const [cam, setCamState] = useState<Cam>(saved ?? { x: 0, y: 0, z: 1 });
  const [cameraReady, setCameraReady] = useState(Boolean(saved));
  const camRef = useRef(cam);
  const needsFit = useRef(!saved);
  const [settled, setSettled] = useState(true);
  const prefetchPreviews = usePreviewPrefetch();
  const raf = useRef(0);
  const settleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const live = useRef(new Set<string>());
  const [spaceDown, setSpaceDown] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReducedMotion(media.matches);
    media.addEventListener("change", update);
    update();
    return () => media.removeEventListener("change", update);
  }, []);
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;

  const frames = room.pageNodes(pageId);
  // Sections wrap their contents; nodes being dragged don't stretch the section they're leaving.
  const rects = layoutRects(frames, (f) => room.heightOf(f), room.dragging);
  const rectOf = (f: CanvasNode) => rects.get(f.id)!;
  const catalogs = catalogSectionIds(frames);
  const sections = frames.filter((f) => f.kind === "section");
  const nodes = frames.filter((f) => f.kind !== "section");
  const topLevel = () => frames.filter((f) => !f.parentId).map(rectOf);
  const navigationRects = [...rects.values()];
  // Page feedback remains reachable too, including threads left after a design was deleted.
  for (const thread of room.comments.values()) {
    if (thread.anchor.pageId !== pageId || thread.resolvedAt !== null && thread.id !== activeCommentId) continue;
    navigationRects.push({ ...commentPoint(thread.anchor, rects), w: 1, h: 1 });
  }
  const navigation = canvasNavigation(navigationRects, size);
  const navigationRef = useRef(navigation);
  navigationRef.current = navigation;

  const setCam = useCallback((next: Cam | ((c: Cam) => Cam)) => {
    const current = camRef.current;
    const bounded = navigationRef.current.constrain(typeof next === "function" ? next(current) : next);
    if (current.x === bounded.x && current.y === bounded.y && current.z === bounded.z) { setCameraReady(true); return; }
    camRef.current = bounded;
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      setCamState(camRef.current);
      setCameraReady(true);
    });
    setSettled(false);
    clearTimeout(settleTimer.current);
    settleTimer.current = setTimeout(() => {
      setSettled(true);
      localStorage.setItem(camKey(pageId), JSON.stringify(camRef.current));
    }, 220);
  }, [pageId]);

  useLayoutEffect(() => {
    const el = rootRef.current!;
    const ro = new ResizeObserver(() => setSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => canvasGestureBoundary(rootRef.current!), []);

  /**
   * Glides the camera to `target`: zoom eases in log space and the viewport centre travels in world space,
   * so content doesn't swing sideways mid-zoom. Any direct input (wheel, drag) cancels it.
   */
  const tween = useRef(0);
  const animateCam = useCallback((target: Cam, ms = 280) => {
    cancelAnimationFrame(tween.current);
    target = navigationRef.current.constrain(target);
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return setCam(target);
    const from = camRef.current, t0 = performance.now();
    const center = (c: Cam) => ({ x: (size.w / 2 - c.x) / c.z, y: (size.h / 2 - c.y) / c.z });
    const a = center(from), b = center(target);
    const step = (now: number) => {
      const k = Math.min(1, (now - t0) / ms);
      const e = 1 - (1 - k) ** 3;
      const z = Math.exp(Math.log(from.z) + (Math.log(target.z) - Math.log(from.z)) * e);
      const cx = a.x + (b.x - a.x) * e, cy = a.y + (b.y - a.y) * e;
      setCam({ z, x: size.w / 2 - cx * z, y: size.h / 2 - cy * z });
      if (k < 1) tween.current = requestAnimationFrame(step);
    };
    tween.current = requestAnimationFrame(step);
  }, [size, setCam]);
  const stopTween = () => cancelAnimationFrame(tween.current);

  // Resize, live layout changes and old saved cameras must obey the same limits as direct gestures.
  useLayoutEffect(() => {
    if (!size.w || !size.h || room.status !== "open") return;
    const current = camRef.current, bounded = navigationRef.current.constrain(current);
    if (current.x === bounded.x && current.y === bounded.y && current.z === bounded.z) return;
    cancelAnimationFrame(tween.current);
    setCam(bounded);
  }, [size.w, size.h, room.status, navigation.bounds.x, navigation.bounds.y, navigation.bounds.w, navigation.bounds.h, setCam]);

  useEffect(() => () => {
    cancelAnimationFrame(tween.current);
    cancelAnimationFrame(raf.current);
    clearTimeout(settleTimer.current);
  }, []);

  useEffect(() => {
    const thread = commentFocus && room.comments.get(commentFocus.id);
    const anchor = draftComment ?? thread?.anchor;
    if (!anchor || anchor.pageId !== pageId || !size.w) return;
    const point = commentPoint(anchor, rects);
    const z = clamp(camRef.current.z, 0.5, 2);
    animateCam({ z, x: size.w / 2 - point.x * z, y: size.h / 2 - point.y * z });
  }, [commentFocus?.request, draftComment, size.w, size.h]);

  const fitTo = useCallback((rects: Rect[], maxZ = 1, animate = true) => {
    if (!size.w) return;
    const target = navigationRef.current.fit(rects, maxZ);
    animate ? animateCam(target) : setCam(target);
  }, [size, setCam, animateCam]);

  // First visit to a page: fit its content.
  useEffect(() => {
    if (!needsFit.current || !size.w || room.status !== "open") return;
    needsFit.current = false;
    if (navigationRects.length) fitTo([], 1, false);
    else setCam({ x: size.w / 2 - 400, y: size.h / 2 - 300, z: 1 });
  });

  const zoomAt = useCallback((sx: number, sy: number, factor: number, animate = false) => {
    const c = camRef.current;
    const z = clamp(c.z * factor, navigationRef.current.minZoom, MAX_CANVAS_ZOOM);
    const target = { z, x: sx - (sx - c.x) * (z / c.z), y: sy - (sy - c.y) * (z / c.z) };
    animate ? animateCam(target, 200) : setCam(target);
  }, [setCam, animateCam]);

  const toWorld = useCallback((sx: number, sy: number) => {
    const c = camRef.current;
    return { x: (sx - c.x) / c.z, y: (sy - c.y) / c.z };
  }, []);

  /** Topmost frame under a screen point, else the innermost section around it. */
  const hitTest = (sx: number, sy: number) => {
    const w = toWorld(sx, sy);
    for (let i = nodes.length - 1; i >= 0; i--) if (contains(rectOf(nodes[i]!), w.x, w.y)) return nodes[i]!.id;
    return innermostSection(w.x, w.y);
  };

  const innermostSection = (x: number, y: number, exclude?: Set<string>) => {
    let best: CanvasNode | null = null;
    for (const s of sections) {
      if (exclude?.has(s.id) || !contains(rectOf(s), x, y)) continue;
      if (!best || rectOf(s).w * rectOf(s).h < rectOf(best).w * rectOf(best).h) best = s;
    }
    return best?.id ?? null;
  };



  // ---- visibility & level of detail -----------------------------------------

  const dpr = devicePixelRatio;
  const highImages = useRef(new Set<string>());
  const renderPlan = planCanvasRendering(frames, rects, {
    camera: cam,
    size,
    pixelRatio: dpr,
    ready: cameraReady,
    settled,
    previous: { liveIds: live.current, imageIds: highImages.current },
  });
  live.current = renderPlan.liveIds;
  highImages.current = renderPlan.imageIds;
  const { sections: visibleSections, domFrames, rasterFrames } = renderPlan;
  const liveIds = [...renderPlan.liveIds];
  useEffect(() => {
    room.needSources(liveIds);
    return () => room.needSources([]);
  }, [room, liveIds.join(",")]);
  const design = room.design();

  // Paint the small frames onto the raster layer, in sync with the DOM layer's transform.
  const rasterRef = useRef<HTMLCanvasElement>(null);
  const thumbnailCache = useRef<ThumbnailCache | null>(null);
  const highPreviewCache = useRef<ThumbnailCache | null>(null);
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const now = performance.now();
  // DOM frames animate in CSS. Only visible raster effects need a continuous redraw.
  const animating = !reducedMotion && rasterFrames.some(({ node: f, visibleArea }) => visibleArea > 0 && (
    room.agentActivity.has(f.id) ||
    now - (room.agentDone.get(f.id) ?? -Infinity) < LOCK_MS ||
    now - (room.appeared.get(f.id) ?? -Infinity) < MATERIALIZE_MS
  ));
  useEffect(() => {
    if (!animating) return;
    let id = requestAnimationFrame(function tick() {
      redraw();
      id = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(id);
  }, [animating]);
  useLayoutEffect(() => {
    let pending = 0;
    const changed = () => {
      if (!pending) pending = requestAnimationFrame(() => { pending = 0; redraw(); });
    };
    const cache = new ThumbnailCache(changed);
    const highCache = new ThumbnailCache(changed, { maxEntries: 32, maxPixels: 32 * 1024 * 1024, maxConcurrent: 2 });
    thumbnailCache.current = cache;
    highPreviewCache.current = highCache;
    return () => {
      cache.dispose();
      highCache.dispose();
      if (thumbnailCache.current === cache) thumbnailCache.current = null;
      if (highPreviewCache.current === highCache) highPreviewCache.current = null;
      cancelAnimationFrame(pending);
    };
  }, []);

  // Auto-height frames report their content height from inside the iframe.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const h = (e.data as { sharpnerHeight?: number } | null)?.sharpnerHeight;
      if (typeof h !== "number") return;
      for (const iframe of rootRef.current?.querySelectorAll("iframe") ?? []) {
        if (iframe.contentWindow === e.source) room.setHeight(iframe.dataset.id!, h);
      }
    };
    addEventListener("message", onMessage);
    return () => removeEventListener("message", onMessage);
  }, [room]);

  // ---- wheel: pan, pinch/ctrl to zoom -----------------------------------------

  useEffect(() => {
    const el = rootRef.current!;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      cancelAnimationFrame(tween.current);
      const b = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        const d = clamp(e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY, -60, 60);
        zoomAt(e.clientX - b.left, e.clientY - b.top, Math.exp(-d * 0.01));
      } else {
        const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
        const dy = e.shiftKey && !e.deltaX ? 0 : e.deltaY;
        setCam((c) => ({ ...c, x: c.x - dx, y: c.y - dy }));
      }
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt, setCam]);

  // ---- keyboard ---------------------------------------------------------------

  useEffect(() => {
    const typing = (e: KeyboardEvent) => (e.target as HTMLElement).closest?.("input, textarea, [contenteditable=true]");
    const down = (e: KeyboardEvent) => {
      if (typing(e)) return;
      const mod = e.metaKey || e.ctrlKey;
      const center = () => [size.w / 2, size.h / 2] as const;
      if (e.code === "Space") {
        setSpaceDown(true);
        e.preventDefault();
      } else if (e.shiftKey && e.code === "Digit1") {
        fitTo([]);
      } else if (e.shiftKey && e.code === "Digit2") {
        const targets = frames.filter((f) => selectionRef.current.includes(f.id)).map(rectOf);
        if (targets.length) fitTo(targets, 2);
      } else if ((e.shiftKey || mod) && e.code === "Digit0") {
        e.preventDefault();
        zoomAt(...center(), 1 / camRef.current.z, true);
      } else if (mod && (e.key === "=" || e.key === "+")) {
        e.preventDefault();
        zoomAt(...center(), 1.25, true);
      } else if (mod && e.key === "-") {
        e.preventDefault();
        zoomAt(...center(), 0.8, true);
      } else if (readOnly) {
        return;
      } else if (mod && e.key === "a") {
        e.preventDefault();
        onSelect(nodes.map((f) => f.id));
      } else if (e.key === "Escape") {
        onSelect([]);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selectionRef.current.length) {
        room.send([{ t: "node.del", ids: selectionRef.current }]);
        onSelect([]);
      }
    };
    const up = (e: KeyboardEvent) => e.code === "Space" && setSpaceDown(false);
    addEventListener("keydown", down);
    addEventListener("keyup", up);
    return () => {
      removeEventListener("keydown", down);
      removeEventListener("keyup", up);
    };
  });

  // ---- pointer: pan, select, move, marquee ------------------------------------

  const gesture = useRef<
    | { kind: "pan"; sx: number; sy: number; moved: boolean }
    | { kind: "move"; sx: number; sy: number; moved: boolean; start: Map<string, { x: number; y: number }>; anchors: Map<string, { x: number; y: number }>; roots: string[]; sentAt: number }
    | { kind: "marquee"; wx: number; wy: number; base: string[] }
    | null
  >(null);

  const local = (e: React.PointerEvent) => {
    const b = rootRef.current!.getBoundingClientRect();
    return { sx: e.clientX - b.left, sy: e.clientY - b.top };
  };

  const placeComment = (sx: number, sy: number) => {
    if (readOnly) return;
    const point = toWorld(sx, sy);
    const nodeId = hitTest(sx, sy);
    const rect = nodeId ? rects.get(nodeId) : undefined;
    onPlaceComment?.({ pageId, nodeId, x: point.x - (rect?.x ?? 0), y: point.y - (rect?.y ?? 0) });
  };

  // Touch navigates and selects but never moves nodes: a resting or second finger can't drag a design.
  const touch = useRef(new TouchNavigator());
  const onTouch = (e: React.PointerEvent, phase: "down" | "move" | "up" | "cancel") => {
    const { sx, sy } = local(e);
    const nav = touch.current;
    const action = phase === "down" ? nav.down(e.pointerId, sx, sy, e.timeStamp, e.isPrimary)
      : phase === "move" ? nav.move(e.pointerId, sx, sy)
      : phase === "up" ? nav.up(e.pointerId, e.timeStamp)
      : nav.cancel(e.pointerId);
    if (action.type === "doubletap") {
      const id = hitTest(action.x, action.y);
      const frame = id && room.nodes.get(id);
      if (frame) fitTo([rectOf(frame)], frame.kind === "section" ? 1 : 4);
    } else if (action.type === "tap") {
      if (readOnly) return;
      if (commentMode) return placeComment(action.x, action.y);
      const hit = hitTest(action.x, action.y);
      onSelect(hit ? [hit] : []);
    } else if (action.type !== "none") {
      setCam((c) => applyTouch(c, action, navigationRef.current.minZoom, MAX_CANVAS_ZOOM));
    }
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") {
      stopTween();
      rootRef.current!.setPointerCapture(e.pointerId);
      return onTouch(e, "down");
    }
    if (e.button !== 0 && e.button !== 1) return;
    stopTween();
    const { sx, sy } = local(e);
    if (commentMode && !readOnly && e.button === 0 && !spaceDown) return placeComment(sx, sy);
    const hit = readOnly ? null : hitTest(sx, sy);
    rootRef.current!.setPointerCapture(e.pointerId);
    if (readOnly || e.button === 1 || spaceDown || (!hit && !e.shiftKey)) {
      gesture.current = { kind: "pan", sx, sy, moved: false };
    } else if (!hit) {
      const w = toWorld(sx, sy);
      gesture.current = { kind: "marquee", wx: w.x, wy: w.y, base: selection };
    } else {
      const id = hit;
      let next = selection;
      if (e.shiftKey) next = selection.includes(id) ? selection.filter((s) => s !== id) : [...selection, id];
      else if (!selection.includes(id)) next = [id];
      onSelect(next);
      // Sections carry their contents. Only "roots" (not inside another moving section) are sent:
      // the server moves a section's contents along with it.
      const inside = descendantsOf(frames, next);
      const roots = next.filter((sid) => !inside.has(sid));
      const start = new Map([...next, ...inside].flatMap((sid) => {
        const f = room.nodes.get(sid);
        const r = f && rectOf(f);
        return r ? [[sid, { x: r.x, y: r.y }] as const] : [];
      }));
      const anchors = new Map(roots.flatMap((sid) => { const f = room.nodes.get(sid); return f ? [[sid, { x: f.x, y: f.y }] as const] : []; }));
      gesture.current = { kind: "move", sx, sy, moved: false, start, anchors, roots, sentAt: 0 };
    }
  };

  const sendMoves = (roots: string[], dropped: boolean, anchors: Map<string, { x: number; y: number }>, start: Map<string, { x: number; y: number }>, point?: { x: number; y: number }) => {
    const moving = new Set(room.dragging);
    const currentFrames = room.pageNodes(pageId);
    const currentRects = layoutRects(currentFrames, (f) => room.heightOf(f), moving);
    const destinations = new Map<string, string | null>();
    const orders = new Map<string, number>();
    if (dropped) {
      for (const id of roots) {
        const f = room.nodes.get(id);
        if (!f) continue;
        const r = currentRects.get(id)!;
        // Use the release point, so a large screen can be dropped into a smaller group by its handle.
        const at = point ?? { x: r.x + r.w / 2, y: r.y + r.h / 2 };
        destinations.set(id, innermostSection(at.x, at.y, moving));
      }
      const groups = new Map<string | null, string[]>();
      for (const [id, parentId] of destinations) {
        const f = room.nodes.get(id)!;
        if (parentId ? room.nodes.get(parentId)?.layout === "auto" : f.kind === "section" && f.layout === "auto") {
          (groups.get(parentId) ?? groups.set(parentId, []).get(parentId)!).push(id);
        }
      }
      for (const [parentId, ids] of groups) {
        const at = point ?? currentRects.get(ids[0]!)!;
        for (const [id, order] of dropOrders(currentFrames, currentRects, ids, parentId, pageId, at)) orders.set(id, order);
      }
    }
    const ops: Op[] = roots.flatMap((id) => {
      const f = room.nodes.get(id);
      if (!f) return [];
      // Managed nodes float locally while dragged; commit their new order only on release.
      if (!dropped && (f.kind === "section" || isManaged(f, room.nodes))) return [];
      const op: Op & { t: "node.put" } = { t: "node.put", id, node: { x: f.x, y: f.y } };
      const parentId = dropped ? destinations.get(id) ?? null : f.parentId;
      // Stored coordinates can differ from visible ones (section padding or automatic ancestors).
      // Same-parent movement sends a delta; reparenting materializes visible coordinates on the server.
      if (parentId === f.parentId) {
        const anchor = anchors.get(id)!, from = start.get(id)!;
        op.node.x = anchor.x + f.x - from.x;
        op.node.y = anchor.y + f.y - from.y;
      }
      if (dropped) {
        // Dropping into (or out of) a section re-parents the node.
        if (parentId !== f.parentId) op.node.parentId = parentId;
        if (orders.has(id)) op.node.order = orders.get(id);
        // Reordering page sections keeps the stack's anchor stable.
        if (!parentId && f.kind === "section" && f.layout === "auto") Object.assign(op.node, anchors.get(id));
      }
      return [op];
    });
    // A precision rebalance occasionally includes stationary siblings; commit it with the drop.
    const rootIds = new Set(roots);
    for (const [id, order] of orders) if (!rootIds.has(id)) ops.push({ t: "node.put", id, node: { order } });
    if (ops.length) room.send(ops);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return onTouch(e, "move");
    const { sx, sy } = local(e);
    if (!readOnly) room.setPresence({ cursor: toWorld(sx, sy) });
    const g = gesture.current;
    if (!g) return;
    if (g.kind === "pan") {
      const dx = sx - g.sx, dy = sy - g.sy;
      if (!g.moved && Math.hypot(dx, dy) < 3) return;
      g.moved = true;
      g.sx = sx;
      g.sy = sy;
      setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
    } else if (g.kind === "move") {
      const dx = (sx - g.sx) / camRef.current.z, dy = (sy - g.sy) / camRef.current.z;
      if (!g.moved && Math.hypot(sx - g.sx, sy - g.sy) < 3) return;
      if (!g.moved) for (const id of g.start.keys()) room.dragging.add(id);
      g.moved = true;
      room.moveLocal(new Map([...g.start].map(([id, p]) => [id, { x: Math.round(p.x + dx), y: Math.round(p.y + dy) }])));
      if (performance.now() - g.sentAt > 100) {
        g.sentAt = performance.now();
        sendMoves(g.roots, false, g.anchors, g.start);
      }
    } else {
      const w = toWorld(sx, sy);
      const r = { x: Math.min(g.wx, w.x), y: Math.min(g.wy, w.y), w: Math.abs(w.x - g.wx), h: Math.abs(w.y - g.wy) };
      setMarquee(r);
      const hits = nodes.filter((f) => {
        const fr = rectOf(f);
        return fr.x < r.x + r.w && fr.x + fr.w > r.x && fr.y < r.y + r.h && fr.y + fr.h > r.y;
      }).map((f) => f.id);
      onSelect([...new Set([...g.base, ...hits])]);
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return onTouch(e, e.type === "pointercancel" ? "cancel" : "up");
    const g = gesture.current;
    gesture.current = null;
    setMarquee(null);
    if (g?.kind === "pan" && !g.moved && !readOnly) onSelect([]);
    if (g?.kind === "move" && g.moved) {
      const { sx, sy } = local(e);
      sendMoves(g.roots, true, g.anchors, g.start, toWorld(sx, sy));
      for (const id of g.start.keys()) room.dragging.delete(id);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (commentMode) return;
    const b = rootRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - b.left, e.clientY - b.top);
    const f = id && room.nodes.get(id);
    if (f) fitTo([rectOf(f)], f.kind === "section" ? 1 : 4);
  };

  // ---- images: drop & paste ---------------------------------------------------

  const placeImages = useCallback(async (files: File[], at: { x: number; y: number }) => {
    let x = at.x;
    const placed: Rect[] = [];
    const images = files.filter((f) => f.type.startsWith("image/"));
    if (!images.length) return placed;
    const done = toast(`Uploading ${images.length === 1 ? images[0]!.name : `${images.length} images`}…`, { sticky: true });
    for (const file of images) {
      try {
        const img = await uploadImage(fileId, file);
        const width = Math.min(img.width, 1200);
        const height = Math.round(img.height * (width / img.width));
        room.send([{ t: "node.put", id: crypto.randomUUID(), node: {
          kind: "image", pageId, name: file.name.replace(/\.[^.]+$/, "") || "Image",
          src: img.src, thumbLo: img.preview, x: Math.round(x), y: Math.round(at.y), width, height,
        } }]);
        placed.push({ x: Math.round(x), y: Math.round(at.y), w: width, h: height });
        x += width + 40;
      } catch (err) {
        toast(`Upload failed: ${(err as Error).message}`, { tone: "error" });
      }
    }
    done(placed.length ? `Added ${placed.length === 1 ? "image" : `${placed.length} images`}` : null);
    return placed;
  }, [fileId, pageId, room]);

  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = [...(e.clipboardData?.files ?? [])];
      if (readOnly || !files.length || (e.target as HTMLElement).closest?.("input, textarea")) return;
      e.preventDefault();
      // Pasted images go to the right of everything on the page (dropped ones land where dropped).
      const all = topLevel();
      const at = all.length ? { x: union(all).x + union(all).w + 80, y: union(all).y } : { x: 0, y: 0 };
      placeImages(files, at).then((placed) => placed.length && fitTo(placed, 1));
    };
    addEventListener("paste", onPaste);
    return () => removeEventListener("paste", onPaste);
  });

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (readOnly) return;
    const b = rootRef.current!.getBoundingClientRect();
    placeImages([...e.dataTransfer.files], toWorld(e.clientX - b.left, e.clientY - b.top));
  };

  // ---- render -----------------------------------------------------------------

  const peers = [...room.peers.values()].filter((p) => p.pageId === pageId);
  const peerSelections = new Map<string, string>();
  for (const p of peers) for (const id of p.selection) peerSelections.set(id, colorFor(p.id));
  const grid = 24 * cam.z;
  const selected = new Set(selection);

  useLayoutEffect(() => {
    if (rasterRef.current) {
      paintRaster(rasterRef.current, size, cam, visibleSections, rasterFrames, selected, peerSelections, catalogs,
        catalogFamilyLabels(frames, rects, catalogs), { agent: room.agentActivity, done: room.agentDone, appeared: room.appeared, now: performance.now(), reducedMotion }, thumbnailCache.current,
        { cache: highPreviewCache.current, enabled: prefetchPreviews, settled });
    }
  });

  return <>
    <div
      ref={rootRef}
      className={`canvas${spaceDown || gesture.current?.kind === "pan" ? " panning" : ""}${commentMode ? " commenting" : ""}`}
      style={{
        backgroundSize: grid < 8 ? "0 0" : `${grid}px ${grid}px`,
        backgroundPosition: `${cam.x}px ${cam.y}px`,
      }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onLostPointerCapture={(e) => { if (e.pointerType === "touch") onTouch(e, "cancel"); }}
      onPointerLeave={() => room.setPresence({ cursor: null })}
      onDoubleClick={onDoubleClick}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDrop}
    >
      <canvas ref={rasterRef} className="raster" style={{ width: size.w, height: size.h }} />
      <div
        className={`world${SECTION_PAD * cam.z < NESTED_LABEL_GAP ? " crowded" : ""}${CATALOG_ROW_GAP * cam.z < NESTED_LABEL_GAP ? " catalog-crowded" : ""}`}
        style={{ transform: `translate(${cam.x}px, ${cam.y}px) scale(${cam.z})`, ["--inv" as string]: 1 / cam.z }}
      >
        {domFrames.map(({ node: f, rect: r, screenWidth }) => {
          const src = room.sources.get(f.id);
          return (
            <FrameNode
              key={f.id}
              frame={f}
              label={nodeLabel(f, catalogs)}
              catalog={catalogs.has(f.parentId ?? "")}
              x={r.x}
              y={r.y}
              height={r.h}
              tier={screenWidth * dpr > HI_RES_MIN_PIXELS ? "hi" : "lo"}
              live={live.current.has(f.id)}
              html={src && renderedHtml(f, src.source)}
              design={design}
              selected={selected.has(f.id)}
              peerColor={peerSelections.get(f.id)}
              agent={room.agentActivity.get(f.id)?.name ?? null}
              settling={room.agentDone.has(f.id)}
              fresh={now - (room.appeared.get(f.id) ?? -Infinity) < MATERIALIZE_MS}
            />
          );
        })}
        {peers.filter((p) => p.cursor && p.cid).map((p) => (
          <div key={p.cid} className="cursor" style={{ left: p.cursor!.x, top: p.cursor!.y, ["--c" as string]: colorFor(p.id) }}>
            <svg width="16" height="16" viewBox="0 0 16 16"><path d="M1 1l5 14 2-6 6-2z" fill="var(--c)" stroke="#fff" strokeWidth="1.2" /></svg>
            <span>{p.name}</span>
          </div>
        ))}
        {!readOnly && [...room.comments.values()].filter((t) => t.anchor.pageId === pageId && (t.resolvedAt === null || t.id === activeCommentId)).map((thread) => {
          const point = commentPoint(thread.anchor, rects);
          return <button key={thread.id} className={`comment-pin${thread.id === activeCommentId ? " active" : ""}${thread.resolvedAt ? " resolved" : ""}`}
            style={{ left: point.x, top: point.y }} aria-label={`Comment ${thread.number} by ${thread.firstMessage.author.name}: ${thread.firstMessage.body}`}
            aria-pressed={thread.id === activeCommentId} title={thread.firstMessage.body}
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onPointerMove={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpenComment?.(thread); }}>
            {thread.number}
          </button>;
        })}
        {!readOnly && draftComment?.pageId === pageId && <span className="comment-pin draft" role="img" aria-label="New comment location"
          style={{ left: commentPoint(draftComment, rects).x, top: commentPoint(draftComment, rects).y }}>+</span>}
      </div>
      {marquee && (
        <div
          className="marquee"
          style={{ left: marquee.x * cam.z + cam.x, top: marquee.y * cam.z + cam.y, width: marquee.w * cam.z, height: marquee.h * cam.z }}
        />
      )}
      {frames.length === 0 && room.status === "open" && (
        <div className="canvas-empty">
          <Empty className="flex-none fade-in"><EmptyHeader>
            <EmptyMedia variant="icon"><IconLayout aria-hidden /></EmptyMedia>
            <EmptyTitle>This page is empty</EmptyTitle>
            <EmptyDescription>{readOnly ? "Designs appear here as soon as they’re added." : "Ask your agent to design something here, or drop in an image."}</EmptyDescription>
          </EmptyHeader></Empty>
        </div>
      )}
    </div>
    <ButtonGroup className="zoom canvas-glass" role="toolbar" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <Button variant="ghost" size="icon" className="zoom-step" disabled={cam.z <= navigation.minZoom} onClick={() => zoomAt(size.w / 2, size.h / 2, 0.8, true)} title="Zoom out (⌘-)" aria-label="Zoom out">
        <IconMinus aria-hidden />
      </Button>
      <Button variant="ghost" className="zoom-pct" onClick={() => zoomAt(size.w / 2, size.h / 2, 1 / cam.z, true)} title="Zoom to 100% (⇧0)" aria-label={`Zoom ${Math.round(cam.z * 100)}%, reset to 100%`}>
        {Math.round(cam.z * 100)}%
      </Button>
      <Button variant="ghost" size="icon" className="zoom-step" onClick={() => zoomAt(size.w / 2, size.h / 2, 1.25, true)} title="Zoom in (⌘+)" aria-label="Zoom in">
        <IconPlus aria-hidden />
      </Button>
      <ButtonGroupSeparator className="zoom-divider" />
      <Button variant="ghost" className="zoom-fit" onClick={() => fitTo([])} title="Zoom to fit (⇧1)" aria-label="Zoom to fit">
        <IconMaximize aria-hidden />
        <span>Fit</span>
      </Button>
    </ButtonGroup>
  </>;
}

type FrameNodeProps = {
  frame: CanvasNode;
  label: string;
  /** Sits in a catalog section, whose tighter rows hide labels sooner. */
  catalog: boolean;
  x: number;
  y: number;
  height: number;
  tier: Tier;
  live: boolean;
  html: string | undefined;
  design: DesignSystem;
  selected: boolean;
  peerColor: string | undefined;
  /** Name of the agent working on this node right now, if any. */
  agent: string | null;
  /** The agent just finished: play the focus-lock. */
  settling: boolean;
  /** Just appeared: rack-focus in. */
  fresh: boolean;
};

const FrameNode = memo(function FrameNode({ frame: f, label, catalog, x, y, height, tier, live, html, design, selected, peerColor, agent, settling, fresh }: FrameNodeProps) {
  const lo = thumbnailSource(f);
  const hi = thumbnailSource(f, true);
  const cls = ["frame", f.kind, f.parentId && "nested", catalog && "catalog-item", selected && "selected", agent && "working", settling && "settle", fresh && "fresh"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-frame={f.id}
      style={{ left: x, top: y, width: f.width, height, ["--peer" as string]: peerColor }}
    >
      <div className="frame-label">{label}</div>
      {agent && <div className="agent-chip"><span className="aperture" />{agent}</div>}
      <div className="frame-body">
        {lo && <img src={lo} alt="" draggable={false} decoding="async" />}
        {tier === "hi" && hi && hi !== lo && <img src={hi} alt="" draggable={false} decoding="async" />}
        {!lo && !live && <div className="frame-placeholder">{f.kind === "image" ? "" : "Rendering…"}</div>}
        {live && html !== undefined && <LiveFrame id={f.id} html={html} design={design} width={f.width} height={height} />}
        {agent && <div className="focus-pull" />}
      </div>
      {(agent || settling) && <div className="brackets"><i /><i /><i /><i /></div>}
      {peerColor && <div className="peer-ring" />}
    </div>
  );
});

function LiveFrame({ id, html, design, width, height }: { id: string; html: string; design: DesignSystem; width: number; height: number }) {
  const [ready, setReady] = useState(false);
  const doc = useMemo(() => frameDocument(html, { measure: true, base: location.origin, design }), [html, design]);
  useEffect(() => setReady(false), [doc]);
  return (
    <iframe
      data-id={id}
      title={id}
      sandbox="allow-scripts"
      srcDoc={doc}
      style={{ width, height, opacity: ready ? 1 : 0 }}
      // Give Tailwind a beat to generate styles before swapping the thumbnail out.
      onLoad={() => setTimeout(() => setReady(true), 120)}
    />
  );
}

// ---- raster layer -------------------------------------------------------------

const COLORS = {
  select: "oklch(0.72 0.14 275)", accent: "oklch(0.82 0.18 78)", muted: "#9d9da6", box: "#202024", edge: "rgba(255,255,255,0.07)",
  component: "#c084fc", tokens: "#f9a8d4", section: "rgba(255,255,255,0.035)", sectionEdge: "rgba(255,255,255,0.07)", sectionText: "#d4d4d8",
  placeholder: "#141416",
};
const KIND_PREFIX: Record<CanvasNode["kind"], string> = { frame: "", image: "", section: "", component: "◆ ", tokens: "◎ " };

/** Catalog rows already name the family in their gutter, so specimens show only their variant. */
function nodeLabel(f: CanvasNode, catalogs: ReadonlySet<string>) {
  return KIND_PREFIX[f.kind] + (catalogs.has(f.parentId ?? "") && familyOf(f.name) ? componentName(f.name).variant : f.name);
}

export function paintRaster(
  canvas: HTMLCanvasElement,
  size: { w: number; h: number },
  cam: Cam,
  sections: ProjectedNode[],
  items: ProjectedNode[],
  selected: Set<string>,
  peers: Map<string, string>,
  catalogs: ReadonlySet<string>,
  families: { family: string; x: number; y: number }[],
  fx: { agent: Map<string, unknown>; done: Map<string, number>; appeared: Map<string, number>; now: number; reducedMotion: boolean },
  thumbnails: ThumbnailCache | null,
  upgrades?: { cache: ThumbnailCache | null; enabled: boolean; settled: boolean },
) {
  const dpr = devicePixelRatio;
  const w = Math.round(size.w * dpr), h = Math.round(size.h * dpr);
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size.w, size.h);
  ctx.textBaseline = "bottom";

  thumbnails?.setViewport(items.flatMap(({ node: f, rect: r, screenWidth: screenW }) => {
    const url = thumbnailSource(f);
    if (!url) return [];
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, height = r.h * cam.z;
    const area = Math.max(0, Math.min(size.w, x + screenW) - Math.max(0, x)) * Math.max(0, Math.min(size.h, y + height) - Math.max(0, y));
    const distance = (x + screenW / 2 - size.w / 2) ** 2 + (y + height / 2 - size.h / 2) ** 2;
    const side = f.kind === "image" ? 400 : 256;
    return [{ url, pixels: side * side * r.h / Math.max(1, r.w), priority: (area > 0 ? 1e12 : 0) + (selected.has(f.id) ? 1e9 : 0) + area * 100 - distance }];
  }));

  // Load small previews first. Sharpen visible content in a separate bounded queue, without
  // promoting DOM nodes, fetching sources, or downloading original uploaded images.
  const highPreviews = upgrades?.cache;
  highPreviews?.setViewport(items.flatMap(({ node: f, rect: r, screenWidth, visibleArea }) => {
    const lo = thumbnailSource(f), hi = f.thumbHi;
    if (f.kind === "image" || !lo || !hi || hi === lo || visibleArea <= 0 || screenWidth * dpr < 64) return [];
    const ready = highPreviews.get(hi);
    if (!ready && (!upgrades?.enabled || !upgrades.settled || !thumbnails?.get(lo))) return [];
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y;
    const distance = (x + screenWidth / 2 - size.w / 2) ** 2 + (y + r.h * cam.z / 2 - size.h / 2) ** 2;
    return [{ url: hi, pixels: 1280 * 1280 * r.h / Math.max(1, r.w), priority: (selected.has(f.id) ? 1e9 : 0) + visibleArea * 100 - distance }];
  }));

  for (const { node: f, rect: r, screenWidth: sw } of sections) {
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, sh = r.h * cam.z;
    const ring = selected.has(f.id) ? COLORS.select : peers.get(f.id);
    ctx.beginPath();
    ctx.roundRect(x, y, sw, sh, Math.min(16, 24 * cam.z));
    ctx.fillStyle = COLORS.section;
    ctx.fill();
    ctx.strokeStyle = ring ?? COLORS.sectionEdge;
    ctx.lineWidth = ring ? 2 : 1;
    ctx.stroke();
  }

  ctx.font = '500 14px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
  for (const { node: f, rect: r, screenWidth: screenW } of items) {
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, sw = screenW, sh = r.h * cam.z;
    const url = thumbnailSource(f);
    const sharper = f.kind !== "image" && f.thumbHi ? highPreviews?.get(f.thumbHi) : null;
    const box = !sharper && Boolean(url && thumbnails && !thumbnails.has(url));
    const img = sharper ?? (!box && url ? thumbnails?.get(url) ?? null : null);
    const born = fx.appeared.get(f.id);
    const fresh = fx.reducedMotion || born === undefined ? 1 : Math.min(1, (fx.now - born) / MATERIALIZE_MS);
    ctx.globalAlpha = 1 - (1 - fresh) ** 3;
    ctx.fillStyle = box ? COLORS.box : img ? "#fff" : COLORS.placeholder;
    if (f.kind !== "image" || !img) ctx.fillRect(x, y, sw, sh);
    if (img) {
      // object-fit: cover, anchored to the top (matches the DOM layer).
      const scale = sw / img.naturalWidth;
      const srcH = Math.min(img.naturalHeight, sh / scale);
      ctx.drawImage(img, 0, 0, img.naturalWidth, srcH, x, y, sw, srcH * scale);
    }
    ctx.globalAlpha = 1;
    const ring = selected.has(f.id) ? COLORS.select : peers.get(f.id);
    if (ring || !box) {
      ctx.strokeStyle = ring ?? COLORS.edge;
      ctx.lineWidth = ring ? 2 : 1;
      ctx.strokeRect(x - 0.5, y - 0.5, sw + 1, sh + 1);
    }
    if (fx.agent.has(f.id)) {
      if (fx.reducedMotion) brackets(ctx, x, y, sw, sh, 4, 1);
      else focusPull(ctx, x, y, sw, sh, fx.now);
    }
    const doneAt = fx.done.get(f.id);
    if (!fx.reducedMotion && doneAt !== undefined) focusLock(ctx, x, y, sw, sh, Math.min(1, (fx.now - doneAt) / LOCK_MS));
    const labelRoom = catalogs.has(f.parentId ?? "") ? CATALOG_ROW_GAP : SECTION_PAD;
    if (sw >= 60 && (!f.parentId || labelRoom * cam.z >= NESTED_LABEL_GAP)) {
      const name = nodeLabel(f, catalogs);
      const max = Math.floor(sw / 7.5);
      ctx.fillStyle = selected.has(f.id) ? COLORS.select : f.kind === "component" ? COLORS.component : f.kind === "tokens" ? COLORS.tokens : COLORS.muted;
      ctx.fillText(name.length > max ? name.slice(0, max - 1) + "…" : name, x, y - 4);
    }
  }

  // Family names in catalog gutters, top-aligned with their row.
  const gutter = (CATALOG_GUTTER - 24) * cam.z;
  if (gutter >= 48 && CATALOG_ROW_GAP * cam.z >= NESTED_LABEL_GAP) {
    ctx.font = '600 13px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
    ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.sectionText;
    const max = Math.floor(gutter / 7.5);
    for (const { family, x, y } of families) {
      const sx = x * cam.z + cam.x, sy = y * cam.z + cam.y;
      if (sy < -20 || sy > size.h || sx > size.w || sx + gutter < 0) continue;
      ctx.fillText(family.length > max ? family.slice(0, max - 1) + "…" : family, sx, sy + 2);
    }
    ctx.textBaseline = "bottom";
  }

  // Section titles last, so neighbouring sections' contents never cover them.
  ctx.font = '700 16px "Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
  for (const { node: f, rect: r, screenWidth: sw } of sections) {
    if (sw < 80 || f.parentId && SECTION_PAD * cam.z < NESTED_LABEL_GAP) continue;
    const max = Math.floor(sw / 9);
    ctx.fillStyle = selected.has(f.id) ? COLORS.select : peers.get(f.id) ?? COLORS.sectionText;
    ctx.fillText(f.name.length > max ? f.name.slice(0, max - 1) + "…" : f.name, r.x * cam.z + cam.x + 2, r.y * cam.z + cam.y - 6);
  }
}

// ---- agent "focus pull" (canvas layer) -------------------------------------------
// While an agent works, the node is softly out of focus except a thin band that sweeps through it,
// bracketed like a camera's focus box. When it finishes, the brackets snap in and the focus "locks".

const BLADE = "255,185,0";

function focusPull(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, now: number) {
  const t = now / 1000;
  const p = (Math.sin(t * 1.3 - Math.PI / 2) + 1) / 2;
  const band = Math.max(6, h * 0.12);
  const cy = y + p * h;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = "rgba(12,12,15,0.45)";
  ctx.fillRect(x, y, w, Math.max(0, cy - band / 2 - y));
  ctx.fillRect(x, cy + band / 2, w, Math.max(0, y + h - cy - band / 2));
  const g = ctx.createLinearGradient(x, 0, x + w, 0);
  g.addColorStop(0, `rgba(${BLADE},0)`);
  g.addColorStop(0.5, `rgba(${BLADE},0.95)`);
  g.addColorStop(1, `rgba(${BLADE},0)`);
  ctx.fillStyle = g;
  ctx.shadowColor = `rgba(${BLADE},0.8)`;
  ctx.shadowBlur = 8;
  ctx.fillRect(x, cy - 0.75, w, 1.5);
  ctx.restore();
  brackets(ctx, x, y, w, h, 7 + Math.sin(t * 3.2) * 2, 1);
}

function focusLock(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, k: number) {
  const e = 1 - (1 - k) ** 3;
  brackets(ctx, x, y, w, h, 7 * (1 - e), 1 - k);
  ctx.strokeStyle = `rgba(${BLADE},${0.8 * (1 - k)})`;
  ctx.lineWidth = 2;
  ctx.strokeRect(x - 1, y - 1, w + 2, h + 2);
}

function brackets(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, gap: number, alpha: number) {
  const L = Math.max(5, Math.min(18, Math.min(w, h) * 0.14));
  const x0 = x - gap, y0 = y - gap, x1 = x + w + gap, y1 = y + h + gap;
  ctx.save();
  ctx.globalAlpha = Math.max(0, alpha);
  ctx.strokeStyle = `rgb(${BLADE})`;
  ctx.shadowColor = `rgba(${BLADE},0.6)`;
  ctx.shadowBlur = 6;
  ctx.lineWidth = 2;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.beginPath();
  for (const [cx, cy, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]] as const) {
    ctx.moveTo(cx, cy + dy * L);
    ctx.lineTo(cx, cy);
    ctx.lineTo(cx + dx * L, cy);
  }
  ctx.stroke();
  ctx.restore();
}
