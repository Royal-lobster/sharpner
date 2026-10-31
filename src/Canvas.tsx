import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { AUTO_ROW_GAP, CATALOG_GUTTER, CATALOG_ROW_GAP, contains, descendantsOf, dropOrders, familyOf, isManaged, union, type Rect } from "../shared/layout";
import { frameDocument, previewCurrent, renderedHtml, type CanvasNode, type CommentAnchor, type CommentThread, type DesignSystem, type Op } from "../shared/types";
import { effectiveTheme, themeLabel } from "../shared/themes";
import { commentPoint } from "../shared/comments";
import { componentName } from "../shared/specimens";
import { colorFor, uploadImage } from "./api";
import { toast } from "./toast";
import { Avatar } from "./Avatar";
import { ThumbnailCache, thumbnailSource } from "./thumbnail-cache";
import { PreviewLoader } from "./preview-loader";
import { applyTouch, TouchNavigator } from "./touch-gestures";
import { canvasGestureBoundary } from "./canvas-gesture-boundary";
import type { Room } from "./room";
import { HI_RES_MIN_PIXELS, planCanvasRendering, type Camera as Cam, type ProjectedNode } from "./canvas-render-plan";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { IconLayout, IconMaximize, IconMinus, IconPlus } from "@tabler/icons-react";
import { usePreviewPrefetch } from "./hooks/use-preview-prefetch";
import { MAX_CANVAS_ZOOM } from "./canvas-navigation";
import { CanvasLayout } from "./canvas-layout";
import { fitLabel, LABEL_FONT, LABEL_ROOM, labelBaseline } from "./canvas-labels";

type Tier = "lo" | "hi";

/** Nested labels sit in the gap above their node: a row gap, or a section's padding. They hide once it can't hold them. */
const labelsFit = (gap: number, z: number) => gap * z >= LABEL_ROOM;
/** How long a newly appeared node takes to rack-focus in. */
const MATERIALIZE_MS = 700;
/** When an agent finishes, the trace closes the outline, then fades. Together they match Room's agentDone lifetime. */
const CLOSE_MS = 500;
const SETTLE_MS = 900;
/** One lap of the graphite trace, and one pass of the sheen; both layers read the same clock. */
const TRACE_MS = 2800;
const SHEEN_MS = 3200;
const tracePhase = (t: number) => (t % TRACE_MS) / TRACE_MS;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const camKey = (pageId: string) => `sharpner:cam:${pageId}`;

type Props = {
  room: Room;
  fileId: string;
  pageId: string;
  selection: string[];
  /** Opening a link or traversing history fits its selection; local selections leave the camera alone. */
  selectionFocus?: { ids: string[] };
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

export function Canvas({ room, fileId, pageId, selection, selectionFocus, onSelect, readOnly = false, commentMode = false, activeCommentId, commentFocus, onPlaceComment, onOpenComment, draftComment }: Props) {
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
  const [cameraReady, setCameraReady] = useState(Boolean(saved) && !selectionFocus?.ids.some((id) => room.nodes.get(id)?.pageId === pageId));
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

  const layout = useMemo(() => new CanvasLayout(room), [room]);
  const { frames, rects, catalogs, sections, nodes, families } = layout.page(pageId);
  const rectOf = (f: CanvasNode) => rects.get(f.id)!;
  const topLevel = () => frames.filter((f) => !f.parentId).map(rectOf);
  const { navigationRects, navigation } = layout.navigation(pageId, size, activeCommentId);
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

  const focusedSelection = useRef<Props["selectionFocus"]>(undefined);
  useEffect(() => {
    if (!selectionFocus?.ids.length || focusedSelection.current === selectionFocus || !size.w || !size.h || room.status !== "open") return;
    const targets = selectionFocus.ids.flatMap((id) => { const rect = rects.get(id); return rect ? [rect] : []; });
    if (!targets.length) return;
    focusedSelection.current = selectionFocus;
    needsFit.current = false;
    cancelAnimationFrame(tween.current);
    fitTo(targets, 1, false);
  }, [selectionFocus, size.w, size.h, room.status, rects, fitTo]);

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
    now - (room.agentDone.get(f.id) ?? -Infinity) < SETTLE_MS ||
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
    const loader = new PreviewLoader();
    const sharpLoader = new PreviewLoader({ maxBatches: 1 });
    const cache = new ThumbnailCache(changed, { loadImage: loader.load, prepareImages: loader.prepare });
    const highCache = new ThumbnailCache(changed, { maxEntries: 32, maxPixels: 32 * 1024 * 1024, maxConcurrent: 2, loadImage: sharpLoader.load, prepareImages: sharpLoader.prepare });
    thumbnailCache.current = cache;
    highPreviewCache.current = highCache;
    return () => {
      cache.dispose();
      highCache.dispose();
      loader.dispose();
      sharpLoader.dispose();
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
        if (iframe.dataset.id && iframe.contentWindow === e.source) room.setHeight(iframe.dataset.id, h);
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
    const { frames: currentFrames, rects: currentRects } = layout.page(pageId);
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
        // Reordering page sections keeps the layout's anchor stable.
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
        families, { agent: room.agentActivity, done: room.agentDone, appeared: room.appeared, now: performance.now(), reducedMotion }, thumbnailCache.current,
        { cache: highPreviewCache.current, enabled: prefetchPreviews, settled });
    }
  });

  return <>
    <div
      ref={rootRef}
      className={`canvas${spaceDown || gesture.current?.kind === "pan" ? " panning" : ""}${commentMode ? " commenting" : ""}`}
      data-ready={cameraReady || undefined}
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
        className={`world${labelsFit(AUTO_ROW_GAP, cam.z) ? "" : " crowded"}${labelsFit(CATALOG_ROW_GAP, cam.z) ? "" : " catalog-crowded"}`}
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
              theme={effectiveTheme(f, room.fileTheme)}
              selected={selected.has(f.id)}
              peerColor={peerSelections.get(f.id)}
              agent={room.agentActivity.get(f.id)?.name ?? null}
              doneAt={room.agentDone.get(f.id)}
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
            aria-pressed={thread.id === activeCommentId} title={`#${thread.number} · ${thread.firstMessage.author.name}: ${thread.firstMessage.body}`}
            onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} onPointerMove={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); onOpenComment?.(thread); }}>
            <Avatar id={thread.firstMessage.author.id} name={thread.firstMessage.author.name} src={thread.firstMessage.author.avatar} agent={thread.firstMessage.author.agent} />
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
  theme: string | undefined;
  selected: boolean;
  peerColor: string | undefined;
  /** Name of the agent working on this node right now, if any. */
  agent: string | null;
  /** When the agent finished, while the trace closes. */
  doneAt: number | undefined;
  /** Just appeared: rack-focus in. */
  fresh: boolean;
};

const FrameNode = memo(function FrameNode({ frame: f, label, catalog, x, y, height, tier, live, html, design, theme, selected, peerColor, agent, doneAt, fresh }: FrameNodeProps) {
  const settling = doneAt !== undefined;
  const lo = thumbnailSource(f);
  const hi = thumbnailSource(f, true);
  const top = tier === "hi" && hi && hi !== lo ? hi : lo;
  // Leaving live rendering (often because a restyled thumbnail just arrived) keeps the live view
  // until the thumbnail that replaces it has loaded; an <img> whose src changes keeps painting its old image meanwhile.
  const [handoff, setHandoff] = useState(false);
  const [wasLive, setWasLive] = useState(live);
  if (wasLive !== live) { setWasLive(live); setHandoff(!live); }
  const topImage = useRef<HTMLImageElement>(null);
  useLayoutEffect(() => {
    if (!handoff) return;
    if (!top || topImage.current?.complete) { setHandoff(false); return; }
    const fallback = setTimeout(() => setHandoff(false), 4000);
    return () => clearTimeout(fallback);
  }, [handoff, top]);
  const showLive = (live || handoff) && html !== undefined;
  const cls = ["frame", f.kind, f.parentId && "nested", catalog && "catalog-item", selected && "selected", agent && "working", settling && "settle", fresh && "fresh", outdated(f) && "outdated"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-frame={f.id}
      style={{ left: x, top: y, width: f.width, height, ["--peer" as string]: peerColor }}
    >
      <div className="frame-label">{label}</div>
      {agent && <div className="agent-chip"><span className="aperture" />{agent}</div>}
      <div className="frame-body">
        {lo && <img ref={top === lo ? topImage : undefined} src={lo} alt="" draggable={false} decoding="async" onLoad={top === lo ? () => setHandoff(false) : undefined} />}
        {tier === "hi" && hi && hi !== lo && <img ref={topImage} src={hi} alt="" draggable={false} decoding="async" onLoad={() => setHandoff(false)} />}
        {!lo && !showLive && <div className="frame-placeholder">{f.kind === "image" ? "" : "Rendering…"}</div>}
        {showLive && <LiveFrame id={f.id} html={html} design={design} theme={theme} width={f.width} height={height} />}
        {(agent || settling) && <AgentSheen />}
      </div>
      {(agent || settling) && <Trace doneAt={doneAt} />}
      {peerColor && <div className="peer-ring" />}
    </div>
  );
});

/** A negative delay fixed at mount puts a CSS loop on the shared clock: its phase at time t is (t % period) / period. */
const useClockDelay = (period: number) => useState(() => `${-(performance.now() % period)}ms`)[0];

function AgentSheen() {
  return <div className="agent-sheen" style={{ ["--sheen-delay" as string]: useClockDelay(SHEEN_MS) }} />;
}

/** The comet's dashes end at the same point; finishing stops the tail where it was and grows it into the full outline. */
function Trace({ doneAt }: { doneAt: number | undefined }) {
  const delay = useClockDelay(TRACE_MS);
  // The path is 100 units long, and a dash starts at -dashoffset.
  const closeFrom = doneAt === undefined ? undefined : -100 * tailStart(doneAt);
  return (
    <svg className="trace" style={{ ["--trace-delay" as string]: delay }} aria-hidden>
      <rect className="trace-rail" pathLength={100} />
      <rect className="trace-lead trace-tail" pathLength={100} style={closeFrom === undefined ? undefined : { strokeDashoffset: closeFrom }} />
      <rect className="trace-lead trace-body" pathLength={100} />
      <rect className="trace-lead trace-head" pathLength={100} />
    </svg>
  );
}

type LiveLayer = { doc: string; key: number; ready: boolean; swap: boolean };

/**
 * A live preview that swaps documents without blinking: the shown iframe stays until its
 * replacement has loaded and styled, so a theme or source change never reveals the outdated
 * thumbnail underneath. Only the newest document reports heights.
 */
function LiveFrame({ id, html, design, theme, width, height }: { id: string; html: string; design: DesignSystem; theme: string | undefined; width: number; height: number }) {
  const doc = useMemo(() => frameDocument(html, { measure: true, base: location.origin, design, theme }), [html, design, theme]);
  const [layers, setLayers] = useState<LiveLayer[]>(() => [{ doc, key: 0, ready: false, swap: false }]);
  const newest = layers[layers.length - 1]!;
  if (newest.doc !== doc) {
    // Replace a still-loading document; keep the one on screen as the backdrop.
    const shown = layers.find((layer) => layer.ready);
    setLayers([...(shown ? [shown] : []), { doc, key: newest.key + 1, ready: false, swap: !!shown }]);
  }
  const reveal = (key: number) => setLayers((current) => {
    const at = current.findIndex((layer) => layer.key === key);
    return at < 0 ? current : [{ ...current[at]!, ready: true }, ...current.slice(at + 1)];
  });
  return layers.map((layer) => {
    const latest = layer === newest;
    return (
      <iframe
        key={layer.key}
        data-id={latest ? id : undefined}
        title={id}
        aria-hidden={latest ? undefined : true}
        tabIndex={latest ? undefined : -1}
        sandbox="allow-scripts"
        srcDoc={layer.doc}
        // A first preview fades in over its thumbnail; a replacement swaps in one frame, with nothing between.
        style={{ width, height, opacity: layer.ready ? 1 : 0, zIndex: latest ? 1 : 0, transition: layer.swap ? "none" : undefined }}
        // Give Tailwind a beat to generate styles before swapping the previous view out.
        onLoad={() => setTimeout(() => reveal(layer.key), 120)}
      />
    );
  });
}

// ---- raster layer -------------------------------------------------------------

const COLORS = {
  select: "oklch(0.72 0.14 275)", accent: "oklch(0.82 0.17 78)", muted: "#aca397", box: "#24201c", edge: "rgba(255,240,215,0.08)",
  component: "#c084fc", tokens: "#f9a8d4", section: "rgba(255,236,200,0.035)", sectionEdge: "rgba(255,240,215,0.08)", sectionText: "#dcd7cf",
  placeholder: "#171412",
};
const KIND_PREFIX: Record<CanvasNode["kind"], string> = { frame: "", image: "", section: "", component: "◆ ", tokens: "◎ " };

/** Catalog rows already name the family in their gutter, so specimens show only their variant. */
function nodeLabel(f: CanvasNode, catalogs: ReadonlySet<string>) {
  const name = catalogs.has(f.parentId ?? "") && familyOf(f.name) ? componentName(f.name).variant : f.name;
  // A component theme override shares its default's name; the theme tells them apart.
  return KIND_PREFIX[f.kind] + name + (f.kind === "component" && f.theme ? ` · ${themeLabel(f.theme)}` : "");
}

/** Previews behind their node's revision: kept on screen, dimmed, until the renderer catches up. */
const OUTDATED_ALPHA = 0.45;
const outdated = (f: CanvasNode) => f.kind !== "image" && !!f.thumbHi && !previewCurrent(f);

/** Per canvas, the preview last painted for each node: it stays up while a replacement loads. */
const lastPainted = new WeakMap<HTMLCanvasElement, Map<string, HTMLImageElement>>();

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
  ctx.textBaseline = "alphabetic";

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
  const smallPreviewsReady = !thumbnails || thumbnails.stats.loading === 0 && thumbnails.stats.queued === 0;
  highPreviews?.setViewport(items.flatMap(({ node: f, rect: r, screenWidth, visibleArea }) => {
    const lo = thumbnailSource(f), hi = f.thumbHi;
    if (f.kind === "image" || !lo || !hi || hi === lo || visibleArea <= 0 || screenWidth * dpr < 64) return [];
    const ready = highPreviews.get(hi);
    if (!ready && (!upgrades?.enabled || !upgrades.settled || !smallPreviewsReady || !thumbnails?.get(lo))) return [];
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y;
    const distance = (x + screenWidth / 2 - size.w / 2) ** 2 + (y + r.h * cam.z / 2 - size.h / 2) ** 2;
    // Match the renderer: smaller frames are never enlarged to 1280px when captured.
    const side = Math.min(1280, Math.max(1, Math.round(f.width)));
    return [{ url: hi, pixels: side * side * r.h / Math.max(1, r.w), priority: (selected.has(f.id) ? 1e9 : 0) + visibleArea * 100 - distance }];
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

  ctx.font = LABEL_FONT.node;
  const nodeBaseline = labelBaseline(ctx);
  let painted = lastPainted.get(canvas);
  if (!painted) lastPainted.set(canvas, painted = new Map());
  const paintedNow = new Map<string, HTMLImageElement>();
  for (const { node: f, rect: r, screenWidth: screenW } of items) {
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, sw = screenW, sh = r.h * cam.z;
    const url = thumbnailSource(f);
    const sharper = f.kind !== "image" && f.thumbHi ? highPreviews?.get(f.thumbHi) : null;
    const box = !sharper && Boolean(url && thumbnails && !thumbnails.has(url));
    const current = sharper ?? (!box && url ? thumbnails?.get(url) ?? null : null);
    // A new revision's preview (after a theme or source change) replaces the old one only once loaded,
    // instead of blanking the frame in between.
    const img = current ?? (!box && url ? painted.get(f.id) ?? null : null);
    if (img) paintedNow.set(f.id, img);
    const born = fx.appeared.get(f.id);
    const fresh = fx.reducedMotion || born === undefined ? 1 : Math.min(1, (fx.now - born) / MATERIALIZE_MS);
    // A preview from an earlier revision (say, the previous theme) stays dimmed until its re-render lands.
    ctx.globalAlpha = (1 - (1 - fresh) ** 3) * (img && outdated(f) ? OUTDATED_ALPHA : 1);
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
      if (fx.reducedMotion) traceRail(ctx, x, y, sw, sh, 0.6);
      else { sheen(ctx, x, y, sw, sh, fx.now, 1); trace(ctx, x, y, sw, sh, fx.now); }
    }
    const doneAt = fx.done.get(f.id);
    if (!fx.reducedMotion && doneAt !== undefined) traceClose(ctx, x, y, sw, sh, fx.now, doneAt);
    if (sw >= 60 && (!f.parentId || labelsFit(catalogs.has(f.parentId) ? CATALOG_ROW_GAP : AUTO_ROW_GAP, cam.z))) {
      ctx.fillStyle = selected.has(f.id) ? COLORS.select : f.kind === "component" ? COLORS.component : f.kind === "tokens" ? COLORS.tokens : COLORS.muted;
      ctx.fillText(fitLabel(ctx, nodeLabel(f, catalogs), sw), x, y - nodeBaseline);
    }
  }

  lastPainted.set(canvas, paintedNow);

  // Family names head their catalog row in the gutter, on the same line as the variant labels beside them.
  const gutter = (CATALOG_GUTTER - 24) * cam.z;
  if (gutter >= 48 && labelsFit(CATALOG_ROW_GAP, cam.z)) {
    ctx.font = LABEL_FONT.family;
    const baseline = labelBaseline(ctx);
    ctx.fillStyle = COLORS.sectionText;
    for (const { family, x, y } of families) {
      const sx = x * cam.z + cam.x, sy = y * cam.z + cam.y;
      if (sy < 0 || sy - LABEL_ROOM > size.h || sx > size.w || sx + gutter < 0) continue;
      ctx.fillText(fitLabel(ctx, family, gutter), sx, sy - baseline);
    }
  }

  // Section titles last, so neighbouring sections' contents never cover them.
  ctx.font = LABEL_FONT.section;
  const sectionBaseline = labelBaseline(ctx);
  for (const { node: f, rect: r, screenWidth: sw } of sections) {
    if (sw < 80 || f.parentId && !labelsFit(AUTO_ROW_GAP, cam.z)) continue;
    ctx.fillStyle = selected.has(f.id) ? COLORS.select : peers.get(f.id) ?? COLORS.sectionText;
    ctx.fillText(fitLabel(ctx, f.name, sw), r.x * cam.z + cam.x, r.y * cam.z + cam.y - sectionBaseline);
  }
}

// ---- agent "graphite trace" (canvas layer) ----------------------------------------
// The raster twin of .trace and .agent-sheen: a comet laps the edge while a sheen glides across the node,
// and finishing grows the tail into the full outline. Phases come from the shared clock, so a node keeps
// its place when it moves between layers.

const BLADE = "255,185,0";
const TRACE_GAP = 4;
/** Comet dashes as [length, alpha], all ending at the head (fractions of the perimeter). Mirrors .trace-tail/-body/-head. */
const COMET_TAIL = 0.2;
const COMET_HEAD = 0.03;
const COMET = [[COMET_TAIL, 0.22], [0.09, 0.55], [COMET_HEAD, 1]] as const;
/** Where the comet's tail starts at time t, as a fraction of the perimeter. */
const tailStart = (t: number) => tracePhase(t) + COMET_HEAD - COMET_TAIL;

/** Strokes the stretch of a rectangle's perimeter from `from` to `to`, clockwise from the top-left corner. */
function perimeter(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, from: number, to: number) {
  const total = 2 * (w + h);
  const at = (s: number): [number, number] => {
    let d = (s - Math.floor(s)) * total;
    if (d < w) return [x + d, y];
    if ((d -= w) < h) return [x + w, y + d];
    if ((d -= h) < w) return [x + w - d, y + h];
    return [x, y + h - (d - w)];
  };
  const corners = [0, w / total, (w + h) / total, (2 * w + h) / total];
  ctx.beginPath();
  ctx.moveTo(...at(from));
  for (let lap = Math.floor(from); lap <= Math.floor(to); lap++) {
    for (const c of corners) if (lap + c > from && lap + c < to) ctx.lineTo(...at(lap + c));
  }
  ctx.lineTo(...at(to));
  ctx.stroke();
}

function traceRail(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, alpha: number) {
  ctx.strokeStyle = `rgba(${BLADE},${alpha})`;
  ctx.lineWidth = 1;
  ctx.strokeRect(x - TRACE_GAP, y - TRACE_GAP, w + TRACE_GAP * 2, h + TRACE_GAP * 2);
}

function comet(ctx: CanvasRenderingContext2D, draw: () => void) {
  ctx.save();
  ctx.lineWidth = 1.5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.shadowColor = `rgba(${BLADE},0.7)`;
  ctx.shadowBlur = 3;
  draw();
  ctx.restore();
}

function trace(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, now: number) {
  traceRail(ctx, x, y, w, h, 0.22);
  const head = tracePhase(now) + COMET_HEAD, g = TRACE_GAP;
  comet(ctx, () => {
    for (const [len, alpha] of COMET) {
      ctx.strokeStyle = `rgba(${BLADE},${alpha})`;
      perimeter(ctx, x - g, y - g, w + g * 2, h + g * 2, head - len, head);
    }
  });
}

function traceClose(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, now: number, doneAt: number) {
  const t = now - doneAt, e = 1 - (1 - Math.min(1, t / CLOSE_MS)) ** 3;
  const alpha = t < CLOSE_MS ? 0.4 + 0.6 * e : Math.max(0, 1 - (t - CLOSE_MS) / (SETTLE_MS - CLOSE_MS));
  const start = tailStart(doneAt), g = TRACE_GAP;
  sheen(ctx, x, y, w, h, now, Math.max(0, 1 - t / (SETTLE_MS - CLOSE_MS)));
  comet(ctx, () => {
    ctx.strokeStyle = `rgba(${BLADE},${alpha})`;
    perimeter(ctx, x - g, y - g, w + g * 2, h + g * 2, start, start + COMET_TAIL + (1 - COMET_TAIL) * e);
  });
}

/** Mirrors .agent-sheen: a 100° band over a 300%-wide background, eased from position 120% to -20%. */
function sheen(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, now: number, alpha: number) {
  if (alpha <= 0) return;
  const q = (now % SHEEN_MS) / SHEEN_MS;
  const position = 1.2 - 1.4 * (0.5 - 0.5 * Math.cos(Math.PI * q));
  const cx = x + w * (1.5 - 2 * position), cy = y + h / 2;
  const dx = Math.sin((100 * Math.PI) / 180) * w * 0.3, dy = -Math.cos((100 * Math.PI) / 180) * w * 0.3;
  const band = ctx.createLinearGradient(cx - dx, cy - dy, cx + dx, cy + dy);
  band.addColorStop(0, "rgba(255,214,120,0)");
  band.addColorStop(0.4, "rgba(255,214,120,0.14)");
  band.addColorStop(0.5, "rgba(255,236,190,0.22)");
  band.addColorStop(0.6, "rgba(255,214,120,0.14)");
  band.addColorStop(1, "rgba(255,214,120,0)");
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = band;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}
