/**
 * Live previews run authored scripts, and a design that redraws on every animation frame costs that much
 * main thread for as long as it is on screen. Where a browser keeps sandboxed iframes on the canvas's own
 * thread (Safari, Firefox, or Chrome without sandboxed-frame isolation), six live chart prototypes held a
 * drag to about five camera updates per second; where it isolates them, they still kept a core busy while
 * nobody touched the canvas. Pacing bounds what previews' animation frames may take. The canvas pauses
 * them while the camera moves, and at rest splits one main-thread budget among its live previews: a frame
 * that took longer waits in proportion before the next one. Interaction playback documents are not paced.
 */
export const PREVIEW_PACE_MESSAGE = "sharpner:preview-pace";
export type PreviewPaceMessage = { type: typeof PREVIEW_PACE_MESSAGE; paused: boolean; share: number };

/** The share of one core that every live preview's animation frames may use together at rest. */
export const PREVIEW_ANIMATION_BUDGET = 0.3;
/** The canvas admits at most this many live previews; a document assumes the full set until told otherwise. */
const MAX_LIVE_PREVIEWS = 12;

/** One live preview's share of the budget when `live` previews are on screen. */
export function previewAnimationShare(live: number) {
  return PREVIEW_ANIMATION_BUDGET / Math.max(1, live);
}

/** Runs before authored code, inside live preview documents only. Keep it self-contained: it is serialized. */
function previewPacing(type: string, initialShare: number) {
  // Authored top-level declarations (`const parent = …`) shadow these globals for every later script.
  const host = parent, clock = performance, later = setTimeout;
  const nativeFrame = requestAnimationFrame.bind(globalThis);
  const rendered = new MessageChannel();
  let queue = new Map<number, FrameRequestCallback>();
  let lastId = 0, scheduled = false, measuring = false, paused = false;
  let share = initialShare, frameStart = 0, readyAt = 0;
  const schedule = () => {
    if (scheduled || measuring || paused || !queue.size) return;
    scheduled = true;
    nativeFrame(run);
  };
  // This task runs after the browser renders the frame the callbacks changed, so the cost counts style,
  // layout and paint as well as the callbacks. A frame that took `spent` ms waits spent × (1 / share − 1) ms.
  rendered.port1.onmessage = () => {
    measuring = false;
    readyAt = frameStart + (clock.now() - frameStart) / share;
    schedule();
  };
  function run(time: number) {
    scheduled = false;
    if (paused) return;
    // A throttled document keeps its requests and checks again on the next display frame.
    if (clock.now() < readyAt) return schedule();
    const batch = queue;
    queue = new Map();
    frameStart = clock.now();
    measuring = true;
    for (const callback of batch.values()) {
      try { callback(time); } catch (error) { later(() => { throw error; }); }
    }
    rendered.port2.postMessage(0);
  }
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    queue.set(++lastId, callback);
    schedule();
    return lastId;
  };
  globalThis.cancelAnimationFrame = (id: number) => { queue.delete(id); };
  addEventListener("message", (event: MessageEvent) => {
    if (event.source !== host || event.data?.type !== type) return;
    paused = event.data.paused === true;
    const next = event.data.share;
    if (typeof next === "number" && next > 0 && next <= 1) share = next;
    schedule();
  });
}

/** The pacing script, for the head of a live preview document. */
export function previewPacingScript() {
  return `<script data-sharpner-pacing>(${previewPacing.toString()})(${JSON.stringify(PREVIEW_PACE_MESSAGE)},${previewAnimationShare(MAX_LIVE_PREVIEWS)})</script>`;
}
