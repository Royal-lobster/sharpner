import { IconArrowRight } from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
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
        <Button variant="ghost" onClick={signIn} disabled={busy}>Sign in</Button>
      </header>
      <main className="landing-main">
        <section className="landing-hero">
          <div className="landing-copy">
            <h1>Your team and your agents, <span>on one canvas.</span></h1>
            <p>
              Sharpner is a shared infinite canvas for designing product UI. People and AI agents work on the same
              frames, drawing on your design system's tokens and components.
            </p>
            <div className="landing-actions">
              <Button size="lg" className="landing-cta" onClick={signIn} aria-busy={busy || undefined}>
                Get started
                {busy ? <Spinner data-icon="inline-end" aria-hidden /> : <IconArrowRight data-icon="inline-end" aria-hidden />}
              </Button>
              <span className="landing-note">Works with Claude Code and other MCP clients.</span>
            </div>
            <p className="landing-error" role="status" aria-live="polite">{error}</p>
          </div>
          <CanvasCue />
        </section>
        <section className="landing-steps" aria-labelledby="landing-steps-title">
          <h2 id="landing-steps-title">How it works</h2>
          <ol>
            <Step n="01" title="Connect your agent">
              Add Sharpner as an MCP server. Your agent signs in as you and works in the files you can open.
            </Step>
            <Step n="02" title="Watch it draw">
              Frames appear on the canvas as your agent writes them, built from your workspace's tokens and components.
            </Step>
            <Step n="03" title="Point and sharpen">
              Pin feedback anywhere on the canvas, then ask your agent to address it when you're ready.
            </Step>
          </ol>
        </section>
      </main>
      <footer className="landing-footer">
        <span className="landing-brand"><img src="/mark.svg" width={18} height={18} alt="" />Sharpner</span>
        <span>A shared canvas for people and their agents.</span>
      </footer>
    </div>
  );
}

function Step({ n, title, children }: { n: string; title: string; children: ReactNode }) {
  return (
    <li className="landing-step">
      <span className="landing-step-n" aria-hidden>{n}</span>
      <h3>{title}</h3>
      <p>{children}</p>
    </li>
  );
}

/** One flow on a page: feedback waits on one screen, an agent draws the next, and a person looks the flow over
    while the view drifts the way a live canvas does. */
function CanvasCue() {
  return (
    <div className="landing-cue" aria-hidden>
      <div className="cue-world">
        <div className="cue-section"><span>Checkout · proposed</span></div>
        <figure className="cue-frame cue-frame-a">
          <figcaption>Cart</figcaption>
          <div className="cue-body">
            <i className="cue-line cue-title" />
            <i className="cue-item" /><i className="cue-item" /><i className="cue-item" />
            <i className="cue-line cue-total" />
            <i className="cue-button" />
          </div>
        </figure>
        <figure className="cue-frame cue-frame-b">
          <figcaption>Payment</figcaption>
          <div className="cue-work">
            <div className="cue-body cue-building">
              <i className="cue-line cue-title" />
              <i className="cue-field" /><i className="cue-field" />
              <i className="cue-line" />
              <i className="cue-button cue-accent" />
              <span className="cue-sheen" />
            </div>
            <svg className="cue-trace"><rect className="cue-trace-rail" pathLength={100} /><rect className="cue-trace-lead" pathLength={100} /></svg>
          </div>
          <span className="cue-agent"><span className="aperture" />Agent</span>
        </figure>
        <figure className="cue-frame cue-frame-c">
          <figcaption>Confirmed</figcaption>
          <div className="cue-body">
            <i className="cue-check" />
            <i className="cue-line cue-title cue-center" />
            <i className="cue-line cue-center" />
            <i className="cue-button" />
          </div>
        </figure>
        <div className="cue-comment">
          <span className="cue-pin">M</span>
          <span className="cue-bubble">Can the total stay pinned while scrolling?</span>
        </div>
        <span className="cue-cursor">
          <svg viewBox="0 0 16 16" width="16" height="16"><path d="M2 1.5 14 7l-5.2 1.6L6.5 14Z" /></svg>
          <span>You</span>
        </span>
      </div>
    </div>
  );
}
