import { useEffect, useRef, useState } from "react";
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
};

/**
 * One disposable executable document. Each mount is one session: the parent changes `key` to
 * restart (Reset, source, size, design or theme changes) and unmounts it to stop.
 */
export function InteractionFrame({ id, html, design, theme, width, height, title, onStop }: Props) {
  // Props are fixed for the lifetime of a session; a change arrives as a new key.
  const [session] = useState(() => {
    const token = crypto.randomUUID();
    return { token, doc: interactionDocument(html, { base: location.origin, token, design, theme }) };
  });
  const [ready, setReady] = useState(false);
  const iframe = useRef<HTMLIFrameElement>(null);
  const stopRef = useRef(onStop);
  stopRef.current = onStop;

  useEffect(() => {
    const timer = setTimeout(() => stopRef.current("timeout"), INTERACTION_READY_TIMEOUT_MS);
    const receive = (event: MessageEvent) => {
      const reply = interactionReply(event, iframe.current?.contentWindow ?? null, session.token);
      if (reply?.type === "sharpner:interaction-exit") stopRef.current();
      else if (reply) { clearTimeout(timer); setReady(true); }
    };
    addEventListener("message", receive);
    return () => { clearTimeout(timer); removeEventListener("message", receive); };
  }, [session]);

  useEffect(() => {
    if (!ready) return;
    iframe.current?.contentWindow?.postMessage({ type: "sharpner:interaction-start", token: session.token }, "*");
    iframe.current?.focus({ preventScroll: true });
  }, [ready, session]);

  return <>
    <iframe
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
      // The srcdoc's own load precedes readiness. A load after it means authored code navigated away.
      onLoad={() => { if (ready) stopRef.current(); }}
    />
    {!ready && <div className="interaction-loading" role="status">Starting interaction…</div>}
  </>;
}
