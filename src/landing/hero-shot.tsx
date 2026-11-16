import { IconChevronDown, IconMaximize, IconMessageCircle, IconMinus, IconPlus, IconSparkles } from "@tabler/icons-react";
import { Cursor, Face, ORANGE, Pin, Screen, VIOLET } from "./screen";

/**
 * The hero's product shot: the carved editor tilted in perspective, with a comment thread and an
 * "is editing" pill floating above it on flatter planes so their text stays crisp. The editor is laid out
 * at 1280 × 820 CSS pixels; landing.css places and scales it, and the planes, to fit the hero.
 */
export function HeroShot() {
  return (
    <div className="lp-stage" aria-hidden>
      <div className="lp-shot-floor" />
      <div className="lp-shot-space">
        <div className="lp-shot">
          <div className="lp-shot-shadow" />
          <div className="lp-shot-contact" />
          <div className="lp-shot-editor shell">
            <div className="lp-shot-canvas canvas-dots">
              <Section name="Checkout · proposed" count="3 frames" style={{ top: 112, left: 64, width: 712 }} />
              <Section name="Onboarding v2" count="2 frames" style={{ top: 112, left: 800, width: 520 }} />
              <Screen screen="cart" name="Cart" accent={ORANGE} style={{ top: 144, left: 96 }} />
              <Screen screen="pay" name="Payment" accent={ORANGE} state="working" agent={null} style={{ top: 144, left: 320 }} />
              <Screen screen="done" name="Confirmed" accent={ORANGE} style={{ top: 144, left: 544 }} />
              <Screen screen="hello" name="Welcome" accent={VIOLET} style={{ top: 144, left: 832 }} />
              <Screen screen="plan" name="Plan" accent={VIOLET} style={{ top: 144, left: 1056 }} />
              <span className="lp-shot-at" style={{ top: 428, left: 200 }}><Pin active /></span>
              <span className="lp-shot-at" style={{ top: 452, left: 470 }}><Cursor name="Sam" color="#e8a87c" /></span>
              <div className="notch notch-tl lp-shot-dock">
                <span className="mark-tile"><img className="mark" src="/mark.svg" width={18} height={18} alt="" /></span>
                <span className="lp-dock-item lp-dock-strong">Checkout<span className="lp-live" /><IconChevronDown /></span>
                <span className="lp-dock-slash">/</span>
                <span className="lp-dock-item">Flows<IconChevronDown /></span>
              </div>
              <div className="notch notch-tr lp-shot-dock">
                <span className="lp-dock-item lp-dock-people">
                  <span className="lp-faces"><Face initial="S" color="#e8a87c" /><Face initial="M" color="#7cb7e8" /><Face initial="R" color="#8fd6a8" /></span>
                  <span className="lp-live" />
                </span>
                <span className="lp-dock-item lp-dock-comments"><IconMessageCircle />3</span>
                <span className="lp-dock-share key-primary">Share</span>
              </div>
              <div className="notch notch-b lp-shot-dock lp-shot-zoom">
                <span className="well">
                  <span className="key"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round"><path d="M5 3.5 L19 11 L12.6 12.6 L9.6 19 Z" /></svg></span>
                  <span><IconMessageCircle /></span>
                </span>
                <span className="well">
                  <span><IconMinus /></span><span className="lp-zoom-level">62%</span><span><IconPlus /></span><span><IconMaximize /></span>
                </span>
              </div>
            </div>
            <div className="lp-shot-glare" />
          </div>
        </div>
      </div>
      <div className="lp-planes">
        <div className="lp-thread-shadow" />
        <div className="lp-thread floaty">
          <div className="lp-thread-who"><Face initial="M" color="#7cb7e8" /><b>Maya Chen</b><span>2m</span></div>
          <p>Can the total stay pinned?</p>
          <div className="lp-thread-who lp-thread-reply"><span className="lp-agent-face"><IconSparkles /></span><b>Claude Code</b><em>agent</em></div>
          <p className="lp-thread-muted">Pinned it on Cart and Payment.</p>
        </div>
        <div className="lp-pill-shadow" />
        <div className="lp-pill floaty">
          <span className="lp-agent-face"><span className="spinner-ring" /></span>
          <b>Claude Code</b><span>is editing Payment</span>
        </div>
      </div>
    </div>
  );
}

function Section({ name, count, style }: { name: string; count: string; style: { top: number; left: number; width: number } }) {
  return <div className="lp-shot-section" style={style}><span><b>{name}</b>{count}</span></div>;
}
