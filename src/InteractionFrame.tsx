import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { interactionDocument, interactionReply, INTERACTION_READY_TIMEOUT_MS, INTERACTION_SANDBOX } from "../shared/interaction-document";
import type { DesignSystem } from "../shared/types";

type Props = {
  id: string;
  html: string;
  design: DesignSystem;
  theme: string | undefined;
  width: number;
  height: number;
  title?: string;
  onStop: (reason?: "timeout") => void;
  onReady?: () => void;
};

/** One disposable executable document. The parent admits at most one playback instance. */
export function InteractionFrame({ id, html, design, theme, width, height, title, onStop, onReady }: Props) {
  const session = useMemo(() => {
    const token = crypto.randomUUID();
    return { token, doc: interactionDocument(html, { base: location.origin, token, design, theme }) };
  }, [id, html, design, theme]);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [readyToken, setReadyToken] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const ready = readyToken === session.token && !stopped;
  const callbacks = useRef({ onStop, onReady });
  callbacks.current = { onStop, onReady };
  const active = useRef({ token: session.token, ready: false, stopped: false });
  if (active.current.token !== session.token) active.current = { token: session.token, ready: false, stopped };

  const stop = (reason?: "timeout") => {
    if (active.current.stopped) return;
    active.current.stopped = true;
    iframe.current?.blur();
    setStopped(true);
    callbacks.current.onStop(reason);
  };

  useLayoutEffect(() => {
    if (stopped) return;
    const expected = session.token;
    const timer = setTimeout(() => { if (active.current.token === expected) stop("timeout"); }, INTERACTION_READY_TIMEOUT_MS);
    const receive = (event: MessageEvent) => {
      if (active.current.token !== expected || active.current.stopped) return;
      const reply = interactionReply(event, iframe.current?.contentWindow ?? null, expected);
      if (!reply) return;
      if (reply.type === "sharpner:interaction-exit") { stop(); return; }
      clearTimeout(timer);
      if (!active.current.ready) {
        active.current.ready = true;
        setReadyToken(expected);
      }
    };
    addEventListener("message", receive);
    return () => { clearTimeout(timer); removeEventListener("message", receive); };
  }, [session, stopped]);

  useLayoutEffect(() => {
    if (!ready) return;
    iframe.current?.contentWindow?.postMessage({ type: "sharpner:interaction-start", token: session.token }, "*");
    iframe.current?.focus({ preventScroll: true });
    callbacks.current.onReady?.();
  }, [ready, session]);

  if (stopped) return null;
  return <><iframe
    key={session.token}
    ref={iframe}
    data-interaction-id={id}
    title={title ?? `Interact with ${id}`}
    sandbox={INTERACTION_SANDBOX}
    referrerPolicy="no-referrer"
    allow="camera 'none'; microphone 'none'; geolocation 'none'; display-capture 'none'; clipboard-read 'none'; clipboard-write 'none'"
    srcDoc={session.doc}
    tabIndex={ready ? 0 : -1}
    aria-hidden={!ready || undefined}
    style={{ width, height, opacity: ready ? 1 : 0, pointerEvents: ready ? "auto" : "none", zIndex: 2, transition: "none" }}
    // Initial about:blank/srcdoc loads are handled by the scoped bridge and startup deadline.
    // Once the document is ready, a subsequent load disposes playback instead of playing a new URL.
    onLoad={(event) => { if (event.currentTarget === iframe.current && active.current.token === session.token && active.current.ready) stop(); }}
  />{!ready && <div className="interaction-loading" role="status">Starting interaction…</div>}</>;
}
