import { useEffect, useState, type ReactNode } from "react";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

/** Mounts this close together belong to one wait, e.g. config → sign-in → file → canvas. */
const CONTINUE_MS = 250;
const session = { start: 0, end: -Infinity, label: "" };

/**
 * Full-screen waiting state: a warm glint sweeps across the mark. Consecutive mounts
 * continue one session, so stepping through app, sign-in and file loading never restarts the entrance,
 * re-fades an unchanged label, or jumps the animation. Delayed slightly in CSS so fast loads never flash it.
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
    <div className={cn("state loading", canvas && "loading-canvas")} role="status" style={{ ["--loading-offset" as string]: `${mount.offset}ms` }}>
      <span className="loading-mark" aria-hidden>
        <img src="/mark.svg" width={40} height={40} alt="" />
        <span className="loading-glint" />
      </span>
      <span key={label} className={cn("loading-label", label !== mount.label && "fade-in")}>{label}</span>
    </div>
  );
}

/** Full-screen message for errors and dead ends, with the one action that helps. */
export function Notice({ title, message, action }: { title: string; message: ReactNode; action?: ReactNode }) {
  return (
    <div className="state">
      <Empty className="rise max-w-md flex-none" role="alert">
        <EmptyHeader>
          <EmptyMedia><img src="/mark.svg" width={36} height={36} alt="" /></EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>{title}</EmptyTitle>
          <EmptyDescription className="break-words">{message}</EmptyDescription>
        </EmptyHeader>
        {action && <EmptyContent>{action}</EmptyContent>}
      </Empty>
    </div>
  );
}
