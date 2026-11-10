import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from "react";
import { AUTO_ROW_GAP, CATALOG_ROW_GAP, contains, familyOf, TABLE_HEAD, TABLE_PAD_Y, type CatalogLabel, type CatalogTable, type Rect } from "../shared/layout";
import { previewCurrent, renderedHtml, type CanvasNode, type CommentAnchor, type CommentThread, type DesignSystem } from "../shared/types";
import { commentPoint } from "../shared/comments";
import { scopeDesign } from "../shared/component-scope";
import { componentName } from "../shared/specimens";
import { specimenWidth } from "../shared/catalog-specimens";
import type { SectionContents } from "./canvas-layout";
import { colorFor } from "./api";
import { toast } from "./toast";
import { Avatar } from "./Avatar";
import { ThumbnailCache, previewSize, thumbnailSource, type PreviewImage } from "./thumbnail-cache";
import { PreviewLoader } from "./preview-loader";
import { applyTouch, TouchNavigator } from "./touch-gestures";
import { canvasGestureBoundary } from "./canvas-gesture-boundary";
import { marqueeCommit, marqueeRect, marqueeSelection, sameSelection } from "./canvas-marquee";
import type { Room } from "./room";
import { canInteract, HI_RES_MIN_PIXELS, planCanvasRendering, type Camera as Cam, type ProjectedNode } from "./canvas-render-plan";
import { Button } from "@/components/ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "@/components/ui/button-group";
import { Separator } from "@/components/ui/separator";
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { IconLayout, IconMaximize, IconMinus, IconPlayerPlay, IconPlayerStop, IconPlus, IconRotateClockwise } from "@tabler/icons-react";
import { usePreviewPrefetch } from "./hooks/use-preview-prefetch";
import { MAX_CANVAS_ZOOM } from "./canvas-navigation";
import { anchoredToHidden, CanvasLayout } from "./canvas-layout";
import { LiveFrame } from "./live-frame";
import { previewAnimationShare } from "../shared/preview-pacing";
import { InteractionFrame } from "./InteractionFrame";
import { INTERACTION_READY_TIMEOUT_MS } from "../shared/interaction-document";
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
  /** The selection a marquee covers while it is dragged, before onSelect commits it; null otherwise. */
  onMarqueeSelection?: (ids: string[] | null) => void;
  /** Link viewers can look around but never select, move, delete, or add anything. */
  readOnly?: boolean;
  /** Leave component nodes, and sections they empty, off this viewer's canvas. Nothing is sent to the room. */
  hideComponents?: boolean;
  /** The design this viewer is playing, owned by the editor so page and selection changes can end it. */
  interactionId?: string | null;
  onInteract?: (id: string | null) => void;
  commentMode?: boolean;
  activeCommentId?: string | null;
  commentFocus?: { id: string; request: number } | null;
  onPlaceComment?: (anchor: CommentAnchor) => void;
  onOpenComment?: (thread: CommentThread) => void;
  draftComment?: CommentAnchor | null;
};

export function Canvas({ room, fileId, pageId, selection, selectionFocus, onSelect, onMarqueeSelection, readOnly = false, hideComponents = false, interactionId, onInteract, commentMode = false, activeCommentId, commentFocus, onPlaceComment, onOpenComment, draftComment }: Props) {
  useSyncExternalStore(room.subscribe, room.getVersion);
  const rootRef = useRef<HTMLDivElement>(null);
  const [playbackReset, setPlaybackReset] = useState(0);
  // The editor only passes a design that may still be played (see `playbackValid`).
  const playingNode = interactionId ? room.nodes.get(interactionId) : undefined;
  const playingId = playingNode?.id;
  // While playing, the canvas only navigates; the played design receives its own input.
  const navigationOnly = readOnly || !!playingId;
  const stopInteraction = useCallback((reason?: "timeout") => {
    onInteract?.(null);
    rootRef.current?.focus({ preventScroll: true });
    if (reason === "timeout") toast("This interaction didn’t finish loading. Try Interact again.", { tone: "error" });
  }, [onInteract]);
  const startInteraction = useCallback((id: string) => {
    if (canInteract(room.nodes.get(id)) && room.status === "open") onInteract?.(id);
  }, [room, onInteract]);
  const playback = useMemo(() => ({ reset: playbackReset, stop: stopInteraction }), [playbackReset, stopInteraction]);
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
  // A marquee shows its selection here while dragging and writes it to the URL once, on release.
  const [marquee, setMarquee] = useState<{ rect: Rect; selection: string[] } | null>(null);
  const shownSelection = marquee?.selection ?? selection;
  const selectionRef = useRef(shownSelection);
  selectionRef.current = shownSelection;
  // The editor's selection toolbar follows the drag too. It is told only when the covered set changes,
  // and once more (null) when the marquee ends or this page's canvas unmounts.
  const marqueeIds = marquee?.selection ?? null;
  const reportMarquee = useRef(onMarqueeSelection);
  reportMarquee.current = onMarqueeSelection;
  useEffect(() => { reportMarquee.current?.(marqueeIds); }, [marqueeIds]);
  useEffect(() => () => reportMarquee.current?.(null), []);

  const layout = useMemo(() => new CanvasLayout(room), [room]);
  const { frames, rects, catalogs, sections, nodes, labels: catalogLabels, tables: catalogTables, tableCells, sectionContents } = layout.page(pageId, hideComponents);
  const rectOf = (f: CanvasNode) => rects.get(f.id)!;
  const { navigationRects, navigation } = layout.navigation(pageId, size, activeCommentId, hideComponents);
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

  const innermostSection = (x: number, y: number) => {
    let best: CanvasNode | null = null;
    for (const s of sections) {
      if (!contains(rectOf(s), x, y)) continue;
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
    interactionId: playingId,
    previous: { liveIds: live.current, imageIds: highImages.current },
  });
  live.current = renderPlan.liveIds;
  highImages.current = renderPlan.imageIds;
  const { sections: visibleSections, domFrames, rasterFrames } = renderPlan;
  const liveIds = [...renderPlan.liveIds];
  // Live previews split one animation budget, so more of them on screen cost the main thread no more.
  const animationShare = previewAnimationShare(liveIds.length);
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
      // Input inside the played design never reaches here; Escape inside it is handled by its bridge.
      if (playingId) {
        const busy = typing(e) || (e.target as HTMLElement).closest?.("[role=dialog],[role=menu],[role=listbox]");
        if (e.key === "Escape" && !busy && !e.defaultPrevented) { e.preventDefault(); stopInteraction(); }
        return;
      }
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

  // ---- pointer: pan, select, marquee ------------------------------------------
  // Members only view the canvas: dragging a design pans, it never moves it. Agents rearrange designs.

  const gesture = useRef<
    | { kind: "pan"; sx: number; sy: number; moved: boolean; hit?: boolean }
    | { kind: "marquee"; wx: number; wy: number; base: string[]; selection: string[] | null }
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

  // Touch navigates and selects.
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
      if (navigationOnly) return;
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
    const hit = navigationOnly ? null : hitTest(sx, sy);
    rootRef.current!.setPointerCapture(e.pointerId);
    if (!navigationOnly && e.button === 0 && !spaceDown && !hit && e.shiftKey) {
      const w = toWorld(sx, sy);
      gesture.current = { kind: "marquee", wx: w.x, wy: w.y, base: selection, selection: null };
      return;
    }
    if (hit && e.button === 0 && !spaceDown) {
      onSelect(e.shiftKey ? (selection.includes(hit) ? selection.filter((s) => s !== hit) : [...selection, hit]) : selection.includes(hit) ? selection : [hit]);
    }
    gesture.current = { kind: "pan", sx, sy, moved: false, hit: !!hit };
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
    } else {
      const rect = marqueeRect({ x: g.wx, y: g.wy }, toWorld(sx, sy));
      // The gesture keeps the latest result, since the release handler may run before this state renders.
      // An unchanged set keeps its array, so only a change in coverage reaches the editor.
      const covered = marqueeSelection(g.base, rect, nodes, rectOf);
      if (!g.selection || !sameSelection(g.selection, covered)) g.selection = covered;
      setMarquee({ rect, selection: g.selection });
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (e.pointerType === "touch") return onTouch(e, e.type === "pointercancel" ? "cancel" : "up");
    const g = gesture.current;
    gesture.current = null;
    setMarquee(null);
    // A click on empty canvas clears the selection; a click on a design selected it on pointer down.
    if (g?.kind === "pan" && !g.moved && !g.hit && !navigationOnly) onSelect([]);
    if (g?.kind === "marquee") {
      // The URL update renders together with the cleared marquee, so the old selection never shows in between.
      const next = marqueeCommit(selection, g.selection);
      if (next) onSelect(next);
    }
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (commentMode) return;
    const b = rootRef.current!.getBoundingClientRect();
    const id = hitTest(e.clientX - b.left, e.clientY - b.top);
    const f = id && room.nodes.get(id);
    if (f) fitTo([rectOf(f)], f.kind === "section" ? 1 : 4);
  };

  // ---- render -----------------------------------------------------------------

  const peers = [...room.peers.values()].filter((p) => p.pageId === pageId);
  const peerSelections = new Map<string, string>();
  for (const p of peers) for (const id of p.selection) peerSelections.set(id, colorFor(p.id));
  const grid = 24 * cam.z;
  const selected = new Set(shownSelection);

  useLayoutEffect(() => {
    if (rasterRef.current) {
      paintRaster(rasterRef.current, size, cam, visibleSections, rasterFrames, selected, peerSelections, catalogs,
        { labels: catalogLabels, tables: catalogTables, cells: tableCells, contents: sectionContents }, { agent: room.agentActivity, done: room.agentDone, appeared: room.appeared, now: performance.now(), reducedMotion }, thumbnailCache.current,
        { cache: highPreviewCache.current, enabled: prefetchPreviews, settled });
    }
  });

  return <>
    <div
      ref={rootRef}
      tabIndex={-1}
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
      // Capture is lost after every pointerup, when the gesture is already gone. Losing it mid-drag ends a
      // marquee like a release, so its selection is committed rather than dropped by the next gesture.
      onLostPointerCapture={(e) => {
        if (e.pointerType === "touch") onTouch(e, "cancel");
        else if (gesture.current?.kind === "marquee") onPointerUp(e);
      }}
      onPointerLeave={() => room.setPresence({ cursor: null })}
      onDoubleClick={onDoubleClick}
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
              label={nodeLabel(f, catalogs, tableCells)}
              catalog={catalogs.has(f.parentId ?? "")}
              x={r.x}
              y={r.y}
              height={r.h}
              tier={screenWidth * dpr > HI_RES_MIN_PIXELS ? "hi" : "lo"}
              live={live.current.has(f.id)}
              navigating={!settled}
              animationShare={animationShare}
              // A session is keyed by revision, so it waits for the matching source instead of starting stale.
              html={src && (f.id !== playingId || src.rev === f.rev) ? renderedHtml(f, src.source, design) : undefined}
              design={design}
              playback={f.id === playingId ? playback : undefined}
              // Members play from the selection toolbar; link viewers cannot select, so frames offer it.
              onPlay={readOnly && onInteract && canInteract(f) && screenWidth >= PLAY_BUTTON_MIN_WIDTH ? startInteraction : undefined}
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
        {!readOnly && [...room.comments.values()].filter((t) => t.anchor.pageId === pageId && (t.resolvedAt === null || t.id === activeCommentId) && !anchoredToHidden(t.anchor, rects, room)).map((thread) => {
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
          style={{ left: marquee.rect.x * cam.z + cam.x, top: marquee.rect.y * cam.z + cam.y, width: marquee.rect.w * cam.z, height: marquee.rect.h * cam.z }}
        />
      )}
      {frames.length === 0 && room.status === "open" && (
        <div className="canvas-empty">
          <Empty className="flex-none fade-in"><EmptyHeader>
            <EmptyMedia variant="icon"><IconLayout aria-hidden /></EmptyMedia>
            <EmptyTitle>This page is empty</EmptyTitle>
            <EmptyDescription>{readOnly ? "Designs appear here as soon as they’re added." : "Ask your agent to design something here."}</EmptyDescription>
          </EmptyHeader></Empty>
        </div>
      )}
    </div>
    {playingNode && <div className="selection-bar interaction-controls canvas-glass" role="toolbar" aria-label="Interaction playback"
      onPointerDown={(event) => event.stopPropagation()}>
      <span className="selection-name" title={playingNode.name}>{playingNode.name}</span>
      <span className="interaction-status">Interacting</span>
      <Separator orientation="vertical" className="selection-divider" />
      <Button variant="ghost" size="sm" className="selection-action" aria-label="Reset interaction" onClick={() => setPlaybackReset((value) => value + 1)}><IconRotateClockwise aria-hidden />Reset</Button>
      <Button variant="ghost" size="sm" className="selection-action" aria-label="Stop interaction" onClick={() => stopInteraction()}><IconPlayerStop aria-hidden />Stop</Button>
    </div>}
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
  label: string | null;
  /** Sits in a catalog section, whose tighter rows hide labels sooner. */
  catalog: boolean;
  x: number;
  y: number;
  height: number;
  tier: Tier;
  live: boolean;
  /** The camera is moving: live previews hold their animation frames. */
  navigating: boolean;
  /** The share of the main thread this node's live preview may animate with at rest. */
  animationShare: number;
  html: string | undefined;
  design: DesignSystem;
  /** Present only on the design being played. */
  playback?: { reset: number; stop: (reason?: "timeout") => void };
  onPlay?: (id: string) => void;
  selected: boolean;
  peerColor: string | undefined;
  /** Name of the agent working on this node right now, if any. */
  agent: string | null;
  /** When the agent finished, while the trace closes. */
  doneAt: number | undefined;
  /** Just appeared: rack-focus in. */
  fresh: boolean;
};

const FrameNode = memo(function FrameNode({ frame: f, label, catalog, x, y, height, tier, live, navigating, animationShare, html, design, playback, onPlay, selected, peerColor, agent, doneAt, fresh }: FrameNodeProps) {
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
  const showLive = !playback && (live || handoff) && html !== undefined;
  // Only the components this design uses, so an edit to another one keeps its document, iframe and session.
  const usedDesign = html !== undefined && (showLive || playback) ? scopeDesign(html, design) : design;
  const cls = ["frame", f.kind, playback && "interacting", f.parentId && "nested", catalog && "catalog-item", selected && "selected", agent && "working", settling && "settle", fresh && "fresh", outdated(f) && "outdated"].filter(Boolean).join(" ");
  return (
    <div
      className={cls}
      data-frame={f.id}
      style={{ left: x, top: y, width: specimenWidth(f), height, ["--peer" as string]: peerColor }}
    >
      {label && <div className="frame-label">{label}</div>}
      {agent && <div className="agent-chip"><span className="aperture" />{agent}</div>}
      <div className="frame-body">
        {lo && <img ref={top === lo ? topImage : undefined} src={lo} alt="" draggable={false} decoding="async" onLoad={top === lo ? () => setHandoff(false) : undefined} />}
        {tier === "hi" && hi && hi !== lo && <img ref={topImage} src={hi} alt="" draggable={false} decoding="async" onLoad={() => setHandoff(false)} />}
        {!lo && !showLive && !playback && <div className="frame-placeholder">{f.kind === "image" ? "" : "Rendering…"}</div>}
        {showLive && <LiveFrame id={f.id} html={html} design={usedDesign} width={specimenWidth(f)} height={height} paused={navigating} share={animationShare} />}
        {playback && (html === undefined
          ? <InteractionLoading onTimeout={() => playback.stop("timeout")} />
          // A new key is a new session: Reset, or any change to what the design renders.
          : <InteractionFrame key={`${f.rev}:${specimenWidth(f)}:${designKey(usedDesign)}:${playback.reset}`} id={f.id} title={`Interact with ${f.name}`}
              html={html} design={usedDesign} width={specimenWidth(f)} height={height} onStop={playback.stop} />)}
        {(agent || settling) && <AgentSheen />}
      </div>
      {(agent || settling) && <Trace doneAt={doneAt} />}
      {peerColor && <div className="peer-ring" />}
      {onPlay && !playback && <Button className="frame-play" variant="secondary" size="sm" aria-label={`Interact with ${f.name}`}
        onPointerDown={(event) => event.stopPropagation()} onDoubleClick={(event) => event.stopPropagation()}
        onClick={(event) => { event.stopPropagation(); onPlay(f.id); }}>
        <IconPlayerPlay aria-hidden />Interact
      </Button>}
    </div>
  );
});

/** Below this on-screen width a design is too small to use, and the button would cover it. */
const PLAY_BUTTON_MIN_WIDTH = 160;

/**
 * Restarts playback only when the content of the design it plays with changes (see `scopeDesign`). A design
 * revision can change before its new component sources arrive, so object identity alone would restart a
 * session twice.
 */
const designKeys = new WeakMap<DesignSystem, string>();
function designKey(design: DesignSystem) {
  let key = designKeys.get(design);
  if (key === undefined) {
    let hash = 0x811c9dc5;
    const text = [design.tokens, ...design.components.map((c) => `${c.tag}\0${c.html}`)].join("\u0001");
    for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 0x01000193);
    designKeys.set(design, key = `${text.length}:${(hash >>> 0).toString(36)}`);
  }
  return key;
}

/** The source has not arrived yet; give up with the same message as a document that never became ready. */
function InteractionLoading({ onTimeout }: { onTimeout: () => void }) {
  const timeout = useRef(onTimeout);
  timeout.current = onTimeout;
  useEffect(() => {
    const timer = setTimeout(() => timeout.current(), INTERACTION_READY_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, []);
  return <div className="interaction-loading" role="status">Loading interaction…</div>;
}

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

// ---- raster layer -------------------------------------------------------------

const COLORS = {
  text: "#ece7df",
  select: "oklch(0.72 0.14 275)", accent: "oklch(0.82 0.17 78)", muted: "#aca397", box: "#24201c", edge: "rgba(255,240,215,0.08)",
  component: "#c084fc", componentEdge: "rgba(192,132,252,0.6)", tableRule: "rgba(255,240,215,0.14)", tokens: "#f9a8d4", section: "rgba(255,236,200,0.035)", sectionEdge: "rgba(255,240,215,0.08)", sectionText: "#dcd7cf",
  placeholder: "#171412",
};
const KIND_PREFIX: Record<CanvasNode["kind"], string> = { frame: "", image: "", section: "", component: "◆ ", tokens: "◎ " };

/**
 * Catalog rows already name the family in their gutter, so specimens show only their variant. A table's headers
 * name its cells, so they have no label of their own.
 */
function nodeLabel(f: CanvasNode, catalogs: ReadonlySet<string>, cells: ReadonlySet<string>) {
  if (cells.has(f.id)) return null;
  const name = catalogs.has(f.parentId ?? "") && familyOf(f.name) ? componentName(f.name).variant : f.name;
  return KIND_PREFIX[f.kind] + name;
}

/** Previews behind their node's revision: kept on screen, dimmed, until the renderer catches up. */
const OUTDATED_ALPHA = 0.45;
const outdated = (f: CanvasNode) => f.kind !== "image" && !!f.thumbHi && !previewCurrent(f);

/** Per canvas, the preview last painted for each node and the preview it belongs to: it stays up while a replacement loads. */
const lastPainted = new WeakMap<HTMLCanvasElement, Map<string, { image: PreviewImage; url: string }>>();

export function paintRaster(
  canvas: HTMLCanvasElement,
  size: { w: number; h: number },
  cam: Cam,
  sections: ProjectedNode[],
  items: ProjectedNode[],
  selected: Set<string>,
  peers: Map<string, string>,
  catalogs: ReadonlySet<string>,
  catalog: { labels: CatalogLabel[]; tables: CatalogTable[]; cells: ReadonlySet<string>; contents?: ReadonlyMap<string, SectionContents> },
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
    const pixels = side * side * r.h / Math.max(1, r.w);
    const priority = (area > 0 ? 1e12 : 0) + (selected.has(f.id) ? 1e9 : 0) + area * 100 - distance;
    // Warm overview pixels only after the shown image is ready. The existing decoded-pixel,
    // entry and network budgets still apply, and current-revision requests always win admission.
    const alternatives = upgrades?.enabled && upgrades.settled && area > 0 && thumbnails?.get(url)
      ? Object.values(f.thumbnails ?? {}).filter((t) => t.rev === f.rev && t.lo !== url).map((t) => ({ url: t.lo, pixels, priority: priority - 2e12 })) : [];
    return [{ url, pixels, priority }, ...alternatives];
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
    const side = Math.min(1280, Math.max(1, Math.round(specimenWidth(f))));
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

  // Family tables: dashed rules in the gaps between cells, under their specimens. Inner rules give way once
  // they would crowd the cells; the box stays.
  if (catalog.tables.length) {
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = COLORS.tableRule;
  }
  for (const t of catalog.tables) {
    const x = t.x * cam.z + cam.x, y = t.y * cam.z + cam.y, w = t.w * cam.z, h = t.h * cam.z;
    if (x > size.w || y > size.h || x + w < 0 || y + h < 0) continue;
    ctx.beginPath();
    ctx.roundRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h), Math.min(12, 16 * cam.z));
    if (TABLE_PAD_Y * cam.z >= 4) {
      for (const ry of [t.head, ...t.rows]) {
        const sy = Math.round(ry * cam.z + cam.y) + 0.5;
        ctx.moveTo(x, sy); ctx.lineTo(x + w, sy);
      }
      for (const cx of t.columns) {
        const sx = Math.round(cx * cam.z + cam.x) + 0.5;
        ctx.moveTo(sx, y); ctx.lineTo(sx, y + h);
      }
      // Specimens rule between their own cells, so these stop at the header.
      for (const c of t.headColumns ?? []) {
        const sx = Math.round(c.x * cam.z + cam.x) + 0.5;
        ctx.moveTo(sx, c.top * cam.z + cam.y); ctx.lineTo(sx, t.head * cam.z + cam.y);
      }
    }
    ctx.stroke();
  }
  if (catalog.tables.length) ctx.setLineDash([]);

  ctx.font = LABEL_FONT.node;
  const nodeBaseline = labelBaseline(ctx);
  let painted = lastPainted.get(canvas);
  if (!painted) lastPainted.set(canvas, painted = new Map());
  const paintedNow = new Map<string, { image: PreviewImage; url: string }>();
  for (const { node: f, rect: r, screenWidth: screenW } of items) {
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y, sw = screenW, sh = r.h * cam.z;
    const url = thumbnailSource(f);
    const sharper = f.kind !== "image" && f.thumbHi ? highPreviews?.get(f.thumbHi) : null;
    const box = !sharper && Boolean(url && thumbnails && !thumbnails.has(url));
    const current = sharper ?? (!box && url ? thumbnails?.get(url) ?? null : null);
    // A new revision's preview (after a source change) replaces the old one only once loaded,
    // instead of blanking the frame in between. Until then the old one is dimmed like any outdated preview:
    // the node's revision already has its new preview, so full opacity would pass old pixels off as current.
    const previous = !current && !box && url ? painted.get(f.id) : undefined;
    const kept = current ?? previous?.image ?? null;
    const replaced = !!previous && previous.url !== url;
    // The cache closes a bitmap it evicts, even one kept here. A closed bitmap measures 0x0 and
    // drawImage would throw on it, so it no longer counts as a preview.
    const { width: imageW, height: imageH } = kept ? previewSize(kept) : { width: 0, height: 0 };
    const img = imageW > 0 && imageH > 0 ? kept : null;
    if (img) paintedNow.set(f.id, { image: img, url: current ? url! : previous!.url });
    const born = fx.appeared.get(f.id);
    const fresh = fx.reducedMotion || born === undefined ? 1 : Math.min(1, (fx.now - born) / MATERIALIZE_MS);
    // A preview from an earlier revision (say, the previous revision) stays dimmed until its re-render lands.
    ctx.globalAlpha = (1 - (1 - fresh) ** 3) * (img && (outdated(f) || replaced) ? OUTDATED_ALPHA : 1);
    ctx.fillStyle = box ? COLORS.box : img ? "#fff" : COLORS.placeholder;
    if (f.kind !== "image" || !img) ctx.fillRect(x, y, sw, sh);
    if (img) {
      // object-fit: cover, anchored to the top (matches the DOM layer).
      const scale = sw / imageW;
      const srcH = Math.min(imageH, sh / scale);
      ctx.drawImage(img, 0, 0, imageW, srcH, x, y, sw, srcH * scale);
    }
    ctx.globalAlpha = 1;
    const ring = selected.has(f.id) ? COLORS.select : peers.get(f.id);
    // Components keep a purple edge, so they read as definitions rather than screens at any zoom.
    if (ring || !box || f.kind === "component") {
      ctx.strokeStyle = ring ?? (f.kind === "component" ? COLORS.componentEdge : COLORS.edge);
      ctx.lineWidth = ring ? 2 : 1;
      ctx.strokeRect(x - 0.5, y - 0.5, sw + 1, sh + 1);
    }
    if (fx.agent.has(f.id)) {
      if (fx.reducedMotion) traceRail(ctx, x, y, sw, sh, 0.6);
      else { sheen(ctx, x, y, sw, sh, fx.now, 1); trace(ctx, x, y, sw, sh, fx.now); }
    }
    const doneAt = fx.done.get(f.id);
    if (!fx.reducedMotion && doneAt !== undefined) traceClose(ctx, x, y, sw, sh, fx.now, doneAt);
    const label = nodeLabel(f, catalogs, catalog.cells);
    if (label) {
      const color = selected.has(f.id) ? COLORS.select : f.kind === "component" ? COLORS.component : f.kind === "tokens" ? COLORS.tokens : null;
      // A label sits above its node while the gap holds it, then moves inside as a chip rather than disappearing.
      if (!f.parentId || labelsFit(catalogs.has(f.parentId) ? CATALOG_ROW_GAP : AUTO_ROW_GAP, cam.z)) {
        if (sw >= 60) {
          ctx.fillStyle = color ?? COLORS.muted;
          ctx.fillText(fitLabel(ctx, label, sw), x, y - nodeBaseline);
        }
      } else labelChip(ctx, label, x, y, sw, color ?? COLORS.text);
    }
  }

  lastPainted.set(canvas, paintedNow);

  // Family names head their catalog block in the gutter, on the same line as the variant labels or table column
  // headers beside them, with the family's usage note under or after the name. Table row names sit in the gutter,
  // centred on their row; specimen tables also name their theme groups. Zoomed out, family names become chips.
  const roomy = labelsFit(CATALOG_ROW_GAP, cam.z);
  for (const { kind, text, x, y, w, note, noteBelow } of catalog.labels) {
    if (!roomy && kind !== "family") continue;
    if (kind !== "family" && !labelsFit(TABLE_HEAD, cam.z)) continue;
    const room = w * cam.z;
    const sx = x * cam.z + cam.x, sy = y * cam.z + cam.y;
    if (sy + LABEL_ROOM * 4 < 0 || sy - LABEL_ROOM > size.h || sx > size.w || sx + room < 0) continue;
    if (!roomy) { ctx.font = LABEL_FONT.family; labelChip(ctx, text, sx, sy, room, COLORS.sectionText); continue; }
    if (room < (kind === "column" ? 32 : 48)) continue;
    ctx.font = kind === "family" || kind === "group" ? LABEL_FONT.family : LABEL_FONT.node;
    ctx.fillStyle = kind === "family" || kind === "group" ? COLORS.sectionText : COLORS.muted;
    if (kind !== "family") {
      ctx.textBaseline = "middle";
      ctx.fillText(fitLabel(ctx, text, room), sx, sy);
      ctx.textBaseline = "alphabetic";
      continue;
    }
    const name = fitLabel(ctx, text, room), baseline = sy - labelBaseline(ctx);
    ctx.fillText(name, sx, baseline);
    if (!note) continue;
    const nameWidth = ctx.measureText(name).width;
    ctx.font = LABEL_FONT.node;
    ctx.fillStyle = COLORS.muted;
    if (noteBelow) wrapText(ctx, note, room, 3).forEach((line, i) => ctx.fillText(line, sx, sy + 14 + i * 16));
    else if (room - nameWidth > 48) ctx.fillText(fitLabel(ctx, note, room - nameWidth - 12), sx + nameWidth + 12, baseline);
  }

  // Section titles last, so neighbouring sections' contents never cover them. A nested title the gap can't hold
  // moves inside its section; a section whose contents are too small to label counts them instead.
  ctx.font = LABEL_FONT.section;
  const sectionBaseline = labelBaseline(ctx);
  for (const { node: f, rect: r, screenWidth: sw } of sections) {
    if (sw < 80) continue;
    const contents = catalog.contents?.get(f.id);
    const title = contents && contents.width * cam.z < LABEL_CHIP_MIN ? `${f.name} · ${contents.count} ${contents.noun}` : f.name;
    const color = selected.has(f.id) ? COLORS.select : peers.get(f.id) ?? COLORS.sectionText;
    const x = r.x * cam.z + cam.x, y = r.y * cam.z + cam.y;
    if (f.parentId && !labelsFit(AUTO_ROW_GAP, cam.z)) { labelChip(ctx, title, x, y, sw, color); ctx.font = LABEL_FONT.section; continue; }
    ctx.fillStyle = color;
    ctx.fillText(fitLabel(ctx, title, sw), x, y - sectionBaseline);
  }
}

/** Narrowest on-screen node that still shows its own label, as a chip. */
const LABEL_CHIP_MIN = 28;

/** A label inside a node's top-left corner, on a dark scrim so it reads over any design. Draws in the current font. */
function labelChip(ctx: CanvasRenderingContext2D, label: string, x: number, y: number, width: number, color: string) {
  if (width < LABEL_CHIP_MIN) return;
  const text = fitLabel(ctx, label, width - 20);
  if (!text) return;
  const w = Math.min(width - 8, ctx.measureText(text).width + 12);
  ctx.fillStyle = "rgba(18, 16, 14, 0.82)";
  ctx.beginPath();
  ctx.roundRect(Math.round(x + 4), Math.round(y + 4), Math.round(w), 18, 5);
  ctx.fill();
  ctx.strokeStyle = "rgba(255, 240, 215, 0.1)";
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.textBaseline = "middle";
  ctx.fillText(text, Math.round(x + 10), Math.round(y + 13));
  ctx.textBaseline = "alphabetic";
}

/** Up to `max` lines of `text` that fit `width`, the last cut with an ellipsis. */
function wrapText(ctx: CanvasRenderingContext2D, text: string, width: number, max: number) {
  const lines: string[] = [];
  let line = "";
  const words = text.split(/\s+/).filter(Boolean);
  for (let i = 0; i < words.length; i++) {
    const next = line ? `${line} ${words[i]}` : words[i]!;
    if (ctx.measureText(next).width <= width || !line) { line = next; continue; }
    if (lines.length === max - 1) return [...lines, fitLabel(ctx, `${line} ${words.slice(i).join(" ")}`, width)];
    lines.push(line);
    line = words[i]!;
  }
  return line ? [...lines, fitLabel(ctx, line, width)] : lines;
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
