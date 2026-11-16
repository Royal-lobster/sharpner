import {
  IconArrowRight, IconCheck, IconCopy, IconFileText, IconLayout2, IconLibrary, IconMessageCircle, IconPencil,
  IconPlayerPlay, IconPlayerStop, IconRefresh, IconSparkles, IconTerminal2, IconX,
} from "@tabler/icons-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { HeroShot } from "./landing/hero-shot";
import { Face, GREEN, ORANGE, Pin, Screen, VIOLET } from "./landing/screen";
import "./landing.css";

/** A navigation that has not left the page by now has stalled; let the person try again. */
const STALLED_MS = 8000;
/** The public guide an agent follows to connect itself; it needs no account to read. */
const AGENT_GUIDE = "/agent-setup.md";
const REPO = "https://github.com/Royal-lobster/sharpner";

/** The signed-out introduction. `onSignIn` opens sign-in; this page only reports a failure to get there. */
export function Landing({ onSignIn }: { onSignIn: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stalled = useRef<number | undefined>(undefined);
  useEffect(() => {
    // Returning from sign-in with the back button restores this page as it was left.
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

  const actions = (
    <>
      <Button className="lp-cta" onClick={signIn} aria-busy={busy || undefined}>
        Get started{busy ? <span className="spinner-ring lp-busy" aria-hidden /> : <IconArrowRight aria-hidden />}
      </Button>
      <Button asChild variant="secondary" className="lp-cta lp-cta-quiet"><a href={AGENT_GUIDE}><IconTerminal2 aria-hidden />Connect an agent</a></Button>
    </>
  );

  return (
    <div className="landing shell">
      <section className="lp-hero sheet" aria-labelledby="lp-title">
        <header className="lp-header">
          <div className="notch notch-tl lp-brand-notch">
            <span className="mark-tile"><img className="mark" src="/mark.svg" width={18} height={18} alt="" /></span>
            <span className="lp-wordmark">Sharpner</span>
          </div>
          <nav className="notch notch-tr lp-nav" aria-label="Sharpner">
            <a href="#how-it-works">How it works</a>
            <a href="#review">Review</a>
            <a href="#design-systems">Design systems</a>
            <a href="#sharing">Sharing</a>
            <Button variant="secondary" className="lp-sign-in" onClick={signIn} disabled={busy}>Sign in</Button>
          </nav>
        </header>
        <div className="lp-copy">
          <h1 id="lp-title">Agents design.<br /><span>You sharpen.</span></h1>
          <p className="lp-lede">
            Claude Code, Codex or Cursor design your product UI in real HTML on a shared canvas. Your team reviews it live,
            pins comments, and the agent revises the same file.
          </p>
          <div className="lp-actions">{actions}</div>
          <p className="lp-error" role="status" aria-live="polite">{error}</p>
          <p className="lp-works">
            <span>Works with</span> <b>Claude Code</b><i aria-hidden>·</i><b>Codex</b><i aria-hidden>·</i><b>Cursor</b><i className="lp-works-more" aria-hidden>·</i><b className="lp-works-more">any MCP client</b>
          </p>
          <ul className="lp-chips" aria-label="Highlights">
            <li className="well"><IconFileText aria-hidden />Real HTML</li>
            <li className="well"><IconMessageCircle aria-hidden />Comments → revisions</li>
            <li className="well"><IconPlayerPlay aria-hidden />Interact to try it</li>
          </ul>
        </div>
        <HeroShot />
      </section>

      <main className="lp-main sheet">
        <div className="lp-wrap">
          <section id="how-it-works" className="lp-section" aria-labelledby="lp-how">
            <div className="lp-how-head">
              <div>
                <span className="lp-eyebrow">How it works</span>
                <h2 id="lp-how" className="lp-h2 lp-h2-narrow">From prompt to reviewed screen.</h2>
              </div>
              <p className="lp-body">Your agent and your team work in the same file. Nobody exports, uploads or redraws anything along the way.</p>
            </div>
            <ol className="lp-steps well">
              <Step n="01" title="Connect your agent" art={
                <div className="lp-terminal floaty">
                  <span className="lp-dim">› /mcp</span>
                  <span><span className="lp-live" />sharpner · connected</span>
                  <span className="lp-dim">Signed in as Maya Chen</span>
                </div>
              }>Add Sharpner as an MCP server. Your agent signs in as you and works in the files you can open.</Step>
              <Step n="02" title="It designs on the canvas" art={
                <div className="lp-step-pair">
                  <Screen screen="cart" accent={ORANGE} className="lp-zoom-step" />
                  <Screen screen="pay" accent={ORANGE} state="working" className="lp-zoom-step" />
                </div>
              }>Frames appear as your agent writes them, in HTML built from your design system, while the team watches.</Step>
              <Step n="03" title="Your team comments" art={
                <>
                  <div className="lp-step-done"><Screen screen="done" accent={ORANGE} className="lp-zoom-step" /></div>
                  <div className="lp-step-note"><Pin className="lp-pin-sm" /><span className="floaty">Can the total stay pinned?</span></div>
                </>
              }>Members browse, select and pin comments where something needs attention. Only agents change the canvas.</Step>
              <Step n="04" title="The agent revises" art={
                <div className="lp-revised floaty">
                  <span className="lp-agent-chip"><IconSparkles aria-hidden />Claude Code</span>
                  <span>Pinned the total bar on Cart and Payment.</span>
                  <span className="lp-resolved"><IconCheck aria-hidden />Resolved</span>
                </div>
              }>Ask it to address the feedback. It edits the same file, replies in the thread and resolves it when fixed.</Step>
            </ol>
          </section>

          <section id="review" className="lp-section lp-feature" aria-labelledby="lp-review">
            <div className="lp-feature-copy">
              <span className="lp-eyebrow">Review loop</span>
              <h2 id="lp-review" className="lp-h2">Feedback your agent can act on.</h2>
              <p className="lp-body">
                Pin comments to any design and talk them through in threads. When you're ready, ask your agent to address them:
                it reads the thread, edits the design, replies and resolves it once it's fixed.
              </p>
              <Checks items={["Comments pinned to the design itself", "Threads where people and agents reply", "Select screens to point your agent at them"]} />
            </div>
            <Board className="lp-review-board" notch={<><span className="key lp-notch-key"><IconMessageCircle aria-hidden /></span><b>Comments</b><span className="lp-dim lp-num">3</span></>}>
              <Screen screen="pay" name="Payment" accent={ORANGE} state="selected" className="lp-review-screen" />
              <Pin className="lp-review-pin" />
              <div className="lp-review-thread floaty">
                <div className="lp-thread-title"><b>Payment</b><span className="well lp-badge"><IconCheck aria-hidden />Resolved</span></div>
                <Message face={<Face initial="M" color="#7cb7e8" />} who="Maya Chen" when="12m">Can the total stay pinned while scrolling? On small phones it slides out of view.</Message>
                <Message face={<span className="lp-face key-primary"><IconSparkles aria-hidden /></span>} who="Claude Code" tag="Agent" when="9m">
                  Pinned the total bar to the bottom of Cart and Payment. It stays above the keyboard while you type.
                </Message>
                <Message face={<Face initial="M" color="#7cb7e8" />} who="Maya Chen" when="2m" className="lp-review-last">That's it. Thanks!</Message>
                <span className="well lp-reply">Reply…</span>
              </div>
            </Board>
          </section>

          <section id="design-systems" className="lp-section lp-feature lp-feature-flip" aria-labelledby="lp-ds">
            <div className="lp-feature-copy">
              <span className="lp-eyebrow">Design systems</span>
              <h2 id="lp-ds" className="lp-h2">Tokens and components that carry through.</h2>
              <p className="lp-body">
                Keep a file's tokens and components on its Design System page. Agents build every screen from them, and the catalog
                shows each variant side by side.
              </p>
              <Checks items={["Token sheets written in Tailwind CSS", "Components with props, slots and variants", "Link a file as a library to share it across the workspace"]} />
            </div>
            <Board className="lp-ds-board"
              notch={<><span className="key lp-notch-key"><IconLibrary aria-hidden /></span><b>Design System</b></>}
              notchEnd={<span className="key lp-library">Library · 4 files</span>}>
              <div className="lp-ds-top">
                <div className="lp-ds-brand">
                  <div className="lp-ds-label">01 · Brand</div>
                  <div className="lp-ds-card lift">
                    <span className="lp-ds-logo">a</span>
                    <span className="lp-ds-name">Acme Shop</span>
                    <span className="lp-ds-voice">Warm, direct and quick to check out.</span>
                  </div>
                </div>
                <div>
                  <div className="lp-ds-label">02 · Foundations</div>
                  <div className="lp-ds-card lift">
                    <div className="lp-ds-swatches">
                      {["#ff5a1f", "#c2410c", "#ffd0c2", "#f5f5f4", "#111", "#fff"].map((color) => <span key={color} style={{ background: color }} />)}
                    </div>
                    <div className="lp-ds-type"><span>Aa</span><span>Inter · radius 999<span className="lp-ds-more"> · primary #FF5A1F</span></span></div>
                  </div>
                </div>
              </div>
              <div className="lp-ds-label lp-ds-label-gap">03 · Primitive components</div>
              <div className="lp-ds-parts">
                <div><div className="lp-ds-part">Button/Primary</div><div className="lp-ds-cell lift"><span className="lp-ds-primary">Checkout</span></div></div>
                <div><div className="lp-ds-part">Button/Outline</div><div className="lp-ds-cell lift"><span className="lp-ds-outline">Track order</span></div></div>
                <div className="lp-ds-input-col"><div className="lp-ds-part">Input/Default</div><div className="lp-ds-cell lift"><span className="lp-ds-input"><span>Name on card</span>Maya Chen</span></div></div>
              </div>
            </Board>
          </section>

          <section id="sharing" className="lp-section lp-panels" aria-label="Interaction playback and sharing">
            <div className="lp-panel panel">
              <span className="lp-eyebrow">Interaction playback</span>
              <h3 className="lp-h3">Click through it before anyone builds it.</h3>
              <p className="lp-body lp-body-sm">
                Choose Interact on any frame or component to try its clicks, typing, scrolling and motion. Your input stays with you,
                and Reset starts it fresh.
              </p>
              <div className="lp-play well">
                <Screen screen="hello" name="Welcome" accent={VIOLET} state="selected" className="lp-play-screen" />
                <div className="lp-play-bar floaty">
                  <span className="lp-play-status"><IconPlayerPlay aria-hidden />Interacting</span>
                  <span className="key"><IconRefresh aria-hidden />Reset</span>
                  <span className="key"><IconPlayerStop aria-hidden />Stop</span>
                </div>
                <span className="lp-tap"><span /><svg width="18" height="18" viewBox="0 0 18 18"><path d="M2 1.5 L15.5 8.6 L9.3 10 L6.4 16 Z" fill="#fff" stroke="#0b0b0c" strokeWidth="1.2" strokeLinejoin="round" /></svg></span>
              </div>
            </div>
            <div className="lp-panel panel">
              <span className="lp-eyebrow">Sharing</span>
              <h3 className="lp-h3">A live link for the review.</h3>
              <p className="lp-body lp-body-sm">
                Share a view-only canvas that opens on the page and selection you chose. No account needed. Revoke the link when the
                review is done.
              </p>
              <div className="lp-share well">
                <div className="lp-share-behind">
                  <Screen screen="cart" accent={ORANGE} className="lp-zoom-share" />
                  <Screen screen="pay" accent={ORANGE} state="selected" className="lp-zoom-share" />
                  <Screen screen="done" accent={ORANGE} className="lp-zoom-share" />
                </div>
                <div className="lp-share-dialog floaty">
                  <div className="lp-thread-title"><b>Share Checkout</b><IconX className="lp-dim" aria-hidden /></div>
                  <div className="lp-share-row">
                    <div><div className="lp-strong">Review link</div><div className="lp-dim">Anyone with the link can view</div></div>
                    <span className="well lp-badge lp-badge-live"><span className="lp-live" />Live</span>
                  </div>
                  <div className="lp-share-copy">
                    <span className="well">sharpner.app/r/9f2k…</span>
                    <span className="key-primary"><IconCopy aria-hidden />Copy</span>
                  </div>
                  <div className="lp-dim lp-share-opens">Opens on Flows, with Payment selected.</div>
                  <div className="lp-share-foot">
                    <span className="lp-faces"><Face initial="S" color="#e8a87c" /><Face initial="M" color="#7cb7e8" /></span>
                    <span className="lp-revoke">Revoke link</span>
                  </div>
                </div>
              </div>
            </div>
          </section>

          <ul className="lp-points well" aria-label="Principles">
            <Point icon={<IconFileText aria-hidden />} title="HTML is the design format">
              Frames are HTML and Tailwind, so agents read the source, change it precisely and check the render.
            </Point>
            <Point icon={<IconPencil aria-hidden />} title="Only agents change the canvas">
              Members browse, select and comment. The canvas stays exactly as the agent left it.
            </Point>
            <Point icon={<IconLayout2 aria-hidden />} title="Built for the overview">
              Small designs use cached previews; large ones become live HTML as you look closer.
            </Point>
          </ul>

          <section className="lp-closing lift" aria-labelledby="lp-closing">
            <div className="lp-closing-inner rim canvas-dots">
              <Screen screen="stats" accent={GREEN} className="lp-closing-left" />
              <Screen screen="plan" accent={VIOLET} className="lp-closing-right" />
              <div className="notch notch-t lp-closing-notch"><span className="mark-tile"><img className="mark" src="/mark.svg" width={18} height={18} alt="" /></span></div>
              <h2 id="lp-closing">Give your agent room to design.</h2>
              <p>Create a file, connect your agent and review its first screens with your team.</p>
              <div className="lp-actions lp-closing-actions">{actions}</div>
            </div>
          </section>
        </div>
      </main>

      <footer className="lp-footer">
        <span className="lp-footer-brand">
          <span className="lp-wordmark"><span className="mark-tile"><img className="mark" src="/mark.svg" width={14} height={14} alt="" /></span>Sharpner</span>
          <span>A shared canvas for people and their agents.</span>
        </span>
        <nav aria-label="Resources">
          <a href={AGENT_GUIDE}>Connect an agent</a>
          <a href={`${REPO}#readme`} target="_blank" rel="noreferrer">Docs</a>
          <a href={`${REPO}/blob/main/CONTRIBUTING.md#run-locally`} target="_blank" rel="noreferrer">Run locally</a>
          <a href={`${REPO}/blob/main/CONTRIBUTING.md`} target="_blank" rel="noreferrer">Contribute</a>
        </nav>
      </footer>
    </div>
  );
}

function Step({ n, title, art, children }: { n: string; title: string; art: ReactNode; children: ReactNode }) {
  return (
    <li className="lp-step">
      <div className="lp-step-art canvas-dots" aria-hidden>{art}</div>
      <div className="lp-step-title"><span className="key" aria-hidden>{n}</span><h3>{title}</h3></div>
      <p>{children}</p>
    </li>
  );
}

function Checks({ items }: { items: string[] }) {
  return (
    <ul className="lp-checks">
      {items.map((item) => <li key={item}><span className="key" aria-hidden><IconCheck /></span>{item}</li>)}
    </ul>
  );
}

/** A canvas inset in a shell frame, with its toolbar carved into the top corners. */
function Board({ className, notch, notchEnd, children }: { className: string; notch: ReactNode; notchEnd?: ReactNode; children: ReactNode }) {
  return (
    <div className="lp-board lift" aria-hidden>
      <div className={`lp-board-canvas canvas-dots ${className}`}>
        {children}
        <div className="notch notch-tl lp-board-notch">{notch}</div>
        {notchEnd && <div className="notch notch-tr lp-board-notch lp-board-notch-end">{notchEnd}</div>}
      </div>
    </div>
  );
}

function Message({ face, who, tag, when, className, children }: { face: ReactNode; who: string; tag?: string; when: string; className?: string; children: ReactNode }) {
  return (
    <div className={className ? `lp-message ${className}` : "lp-message"}>
      {face}
      <div>
        <div className="lp-message-who"><b>{who}</b>{tag && <span className="well lp-tag">{tag}</span>}<span className="lp-dim">{when}</span></div>
        <p>{children}</p>
      </div>
    </div>
  );
}

function Point({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <li className="lp-point">
      <span className="key" aria-hidden>{icon}</span>
      <div><h3>{title}</h3><p>{children}</p></div>
    </li>
  );
}
