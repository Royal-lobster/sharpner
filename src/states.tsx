import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Mounts this close together belong to one wait, e.g. config → sign-in → file → canvas. */
const CONTINUE_MS = 250;
const session = { start: 0, end: -Infinity, label: "" };

/**
 * Full-screen waiting state: a glint sweeps across the mark on its key. Consecutive mounts
 * continue one session, so stepping through app, sign-in and file loading never restarts the entrance,
 * re-fades an unchanged label, or jumps the animation. Delayed slightly in CSS so fast loads never flash it.
 * `canvas` waits on the canvas sheet itself, so the editor arrives without a background change.
 */
export function Loading({ label, canvas = false }: { label: string; canvas?: boolean }) {
  const [mount] = useState(() => {
    const now = performance.now();
    const continuing = now - session.end <= CONTINUE_MS;
    if (!continuing) session.start = now;
    session.end = Infinity;
    return { offset: session.start - now, label: continuing ? session.label : null };
  });
  useEffect(() => {
    session.end = Infinity;
    session.label = label;
    return () => { session.end = performance.now(); };
  }, [label]);
  return (
    <div className={cn("state loading shell", canvas && "loading-canvas")} role="status" style={{ ["--loading-offset" as string]: `${mount.offset}ms` }}>
      <div className={cn("state-sheet", canvas ? "canvas-dots" : "sheet")}>
        <div className="loading-content">
          <span className="state-mark well" aria-hidden>
            <span className="mark-tile">
              <span className="loading-mark">
                <img className="loading-base" src="/mark.svg" width={32} height={32} alt="" />
                <img className="mark loading-glint" src="/mark.svg" width={32} height={32} alt="" />
              </span>
            </span>
          </span>
          <span key={label} className={cn("loading-label", label !== mount.label && "fade-in")}>{label}</span>
        </div>
      </div>
    </div>
  );
}

/** Full-screen message for errors and dead ends, with the one action that helps. */
export function Notice({ title, message, action }: { title: string; message: ReactNode; action?: ReactNode }) {
  return (
    <div className="state shell">
      <div className="state-sheet sheet">
        <div className="notice rise" role="alert">
          <span className="state-mark well" aria-hidden>
            <span className="mark-tile"><img className="mark" src="/mark.svg" width={26} height={26} alt="" /></span>
          </span>
          <div className="notice-text">
            <h1>{title}</h1>
            <div className="notice-message">{message}</div>
          </div>
          {action && <div className="notice-action">{action}</div>}
        </div>
      </div>
    </div>
  );
}
