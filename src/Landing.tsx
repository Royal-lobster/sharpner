import { IconArrowRight } from "@tabler/icons-react";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import "./landing.css";

/** A navigation that has not left the page by now has stalled; let the person try again. */
const STALLED_MS = 8000;

/** The signed-out introduction. Sign-in itself is Clerk's hosted page; `onSignIn` starts that redirect. */
export function Landing({ onSignIn }: { onSignIn: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stalled = useRef<number | undefined>(undefined);
  useEffect(() => {
    // Returning from the hosted page with the back button restores this page as it was left.
    const restore = (event: PageTransitionEvent) => { if (event.persisted) setBusy(false); };
    addEventListener("pageshow", restore);
    return () => { removeEventListener("pageshow", restore); clearTimeout(stalled.current); };
  }, []);

  const signIn = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    clearTimeout(stalled.current);
    stalled.current = window.setTimeout(() => setBusy(false), STALLED_MS);
    void Promise.resolve().then(onSignIn).catch(() => {
      clearTimeout(stalled.current);
      setBusy(false);
      setError("Sign-in could not be opened. Check your connection and try again.");
    });
  };

  return (
    <div className="landing">
      <header className="landing-bar">
        <span className="landing-brand"><img src="/mark.svg" width={24} height={24} alt="" />Sharpner</span>
      </header>
      <main className="landing-main">
        <div className="landing-copy">
          <h1>Your team and your agents, on one canvas.</h1>
          <p>
            Sharpner is a shared infinite canvas for designing product UI. People and AI agents work on the same
            frames, drawing on your design system's tokens and components.
          </p>
          <div className="landing-actions">
            <Button size="lg" className="landing-cta" onClick={signIn} aria-busy={busy || undefined}>
              Sign in
              {busy ? <Spinner data-icon="inline-end" aria-hidden /> : <IconArrowRight data-icon="inline-end" aria-hidden />}
            </Button>
            <p className="landing-error" role="status" aria-live="polite">{error}</p>
          </div>
        </div>
        <CanvasCue />
      </main>
    </div>
  );
}

/** Two frames on a page: one a person is pointing at, one an agent is working on. */
function CanvasCue() {
  return (
    <div className="landing-cue" aria-hidden>
      <figure className="cue-frame cue-frame-a">
        <figcaption>Onboarding</figcaption>
        <div className="cue-body">
          <i className="cue-line cue-title" /><i className="cue-line" /><i className="cue-field" /><i className="cue-field" /><i className="cue-button" />
        </div>
        <span className="cue-cursor">
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 1.5 14 7l-5.2 1.6L6.5 14Z" /></svg>
          <span>You</span>
        </span>
      </figure>
      <figure className="cue-frame cue-frame-b">
        <figcaption>Settings</figcaption>
        <div className="cue-body">
          <i className="cue-line cue-title" /><i className="cue-row" /><i className="cue-row" /><i className="cue-row" />
          <span className="cue-sheen" />
        </div>
        <span className="cue-agent">Agent</span>
      </figure>
    </div>
  );
}
