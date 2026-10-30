/**
 * Keep a touch sequence that starts on the canvas out of the browser's page pan/pinch recognizers.
 * Native, non-passive listeners supplement touch-action for Safari. Menu scrolling and control taps
 * remain browser gestures; a finger leaving the surface still belongs to its original canvas gesture.
 */
export function canvasGestureBoundary(root: HTMLElement) {
  const doc = root.ownerDocument;
  let owned = false;
  const capture = { capture: true, passive: false };
  const prevent = (event: Event) => { if (event.cancelable) event.preventDefault(); };
  const surface = (target: EventTarget | null) => {
    const el = target as Element | null;
    return !!el && root.contains(el) && !el.closest?.("button,a,input,textarea,select,[role=button],[role=dialog]");
  };
  const start = (event: TouchEvent) => {
    if (!surface(event.target)) return;
    owned = true;
    prevent(event);
  };
  const continuation = (event: TouchEvent) => {
    // A new sequence outside the canvas recovers even when Safari omitted the old touchend.
    if (event.type === "touchstart" && owned && !Array.from(event.touches).some((touch) => surface(touch.target))) owned = false;
    if (owned) prevent(event);
  };
  const finish = (event: TouchEvent) => { if (!event.touches.length) owned = false; };
  const gesture = (event: Event) => { if (owned || surface(event.target)) prevent(event); };
  const reset = () => { owned = false; };
  const visibility = () => { if (doc.hidden) reset(); };

  root.addEventListener("touchstart", start, capture);
  doc.addEventListener("touchstart", continuation, capture);
  doc.addEventListener("touchmove", continuation, capture);
  doc.addEventListener("touchend", finish, capture);
  doc.addEventListener("touchcancel", finish, capture);
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) doc.addEventListener(type, gesture, capture);
  doc.addEventListener("visibilitychange", visibility);
  doc.defaultView?.addEventListener("blur", reset);
  return () => {
    root.removeEventListener("touchstart", start, capture);
    doc.removeEventListener("touchstart", continuation, capture);
    doc.removeEventListener("touchmove", continuation, capture);
    doc.removeEventListener("touchend", finish, capture);
    doc.removeEventListener("touchcancel", finish, capture);
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) doc.removeEventListener(type, gesture, capture);
    doc.removeEventListener("visibilitychange", visibility);
    doc.defaultView?.removeEventListener("blur", reset);
  };
}
