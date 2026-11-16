import { IconCheck } from "@tabler/icons-react";
import type { CSSProperties, ReactNode } from "react";

/** The sample member designs the landing page shows on its canvases. Static markup, sized in CSS pixels
    at any width; a parent shrinks the small ones with `zoom`. */
export type ScreenKind = "cart" | "pay" | "done" | "hello" | "plan" | "stats";

export const ORANGE = "#ff5a1f";
export const VIOLET = "#6d4aff";
export const GREEN = "#34d399";

/**
 * One phone-sized design lifted off the canvas. `selected` adds the two-tone selection ring; `working`
 * adds the agent sweep, with a chip naming the agent in the caption unless `agent` is null.
 */
export function Screen({ screen, accent, name, state = "idle", agent = "Claude Code", className, style }: {
  screen: ScreenKind;
  accent: string;
  name?: string;
  state?: "idle" | "selected" | "working";
  agent?: string | null;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <figure className={className ? `lp-screen ${className}` : "lp-screen"} data-state={state} style={{ ...style, ["--a" as string]: accent }}>
      {name && (
        <figcaption>
          <span className="lp-screen-name">{name}</span>
          {state === "selected" && <span className="lp-screen-size">390 × 760</span>}
          {state === "working" && agent && <span className="lp-screen-agent"><span className="spinner-ring" />{agent}</span>}
        </figcaption>
      )}
      <div className="lp-screen-frame">
        {state === "working" && <><span className="lp-sweep-base" /><span className="lp-sweep agent-sweep" /><span className="lp-sweep-halo agent-sweep" /></>}
        <div className="lp-screen-body">{BODIES[screen]}</div>
      </div>
    </figure>
  );
}

const Check = ({ className }: { className?: string }) => <IconCheck className={className} stroke={2.5} aria-hidden />;

function Row({ swatch, title, detail, price }: { swatch: string; title: string; detail: string; price: string }) {
  return (
    <div className="lp-s-row">
      <span className="lp-s-thumb" style={{ background: swatch }} />
      <div className="lp-s-grow"><div className="lp-s-strong">{title}</div><div className="lp-s-meta">{detail}</div></div>
      <span className="lp-s-strong lp-s-num">{price}</span>
    </div>
  );
}

function Plan({ title, detail, price, chosen }: { title: string; detail: string; price: string; chosen?: boolean }) {
  return (
    <div className="lp-s-plan" data-chosen={chosen || undefined}>
      <span className="lp-s-radio" />
      <div className="lp-s-grow"><div className="lp-s-strong">{title}</div><div className="lp-s-meta">{detail}</div></div>
      <span className="lp-s-strong">{price}</span>
    </div>
  );
}

const BODIES: Record<ScreenKind, ReactNode> = {
  cart: (
    <div className="lp-s lp-s-pad">
      <div className="lp-s-head"><span className="lp-s-title">Your bag</span><span className="lp-s-meta">3 items</span></div>
      <div className="lp-s-rows">
        <Row swatch="color-mix(in srgb, var(--a) 24%, #fff)" title="Linen overshirt" detail="Sand · M" price="$68" />
        <Row swatch="color-mix(in srgb, var(--a) 70%, #000)" title="Merino crew" detail="Ink · L" price="$92" />
        <Row swatch="color-mix(in srgb, var(--a) 10%, #f1efe9)" title="Canvas tote" detail="Natural" price="$54" />
      </div>
      <div className="lp-s-foot">
        <div className="lp-s-line lp-s-dim"><span>Shipping</span><span>Free</span></div>
        <div className="lp-s-line lp-s-total"><span>Total</span><span className="lp-s-num">$214.00</span></div>
        <span className="lp-s-button">Checkout</span>
      </div>
    </div>
  ),
  pay: (
    <div className="lp-s lp-s-pad">
      <span className="lp-s-title">Payment</span>
      <div className="lp-s-card">
        <div className="lp-s-card-top"><span>DEBIT</span><span>MAYA CHEN</span></div>
        <div className="lp-s-card-bottom"><span className="lp-s-pan">•••• 4242</span><span>12/28</span></div>
      </div>
      <div className="lp-s-fields">
        <div className="lp-s-field"><div className="lp-s-label">Name on card</div><div>Maya Chen</div></div>
        <div className="lp-s-pair">
          <div className="lp-s-field"><div className="lp-s-label">Expiry</div><div className="lp-s-num">12 / 28</div></div>
          <div className="lp-s-field lp-s-focus"><div className="lp-s-label">CVC</div><div>•••</div></div>
        </div>
        <div className="lp-s-save"><span className="lp-s-box"><Check /></span>Save card for next time</div>
      </div>
      <div className="lp-s-foot">
        <div className="lp-s-line lp-s-total"><span>Total</span><span className="lp-s-num">$214.00</span></div>
        <span className="lp-s-button">Pay $214.00</span>
      </div>
    </div>
  ),
  done: (
    <div className="lp-s lp-s-pad lp-s-center">
      <span className="lp-s-done"><Check /></span>
      <div className="lp-s-done-title">Order placed</div>
      <div className="lp-s-dim">Arrives Thursday, Nov 20</div>
      <div className="lp-s-receipt">
        <div className="lp-s-line"><span className="lp-s-dim">Order</span><span className="lp-s-strong lp-s-num">#4821</span></div>
        <div className="lp-s-line"><span className="lp-s-dim">3 items</span><span className="lp-s-strong lp-s-num">$214.00</span></div>
      </div>
      <span className="lp-s-button lp-s-outline">Track order</span>
    </div>
  ),
  hello: (
    <div className="lp-s">
      <div className="lp-s-hero"><span /><span /><span /><span /></div>
      <div className="lp-s lp-s-pad">
        <div className="lp-s-dots"><span data-on /><span /><span /></div>
        <div className="lp-s-headline">Plan trips together</div>
        <div className="lp-s-dim lp-s-blurb">Share itineraries, split costs and vote on places with your crew.</div>
        <span className="lp-s-button lp-s-ink">Get started</span>
        <span className="lp-s-dim lp-s-link">I have an account</span>
      </div>
    </div>
  ),
  plan: (
    <div className="lp-s lp-s-pad">
      <div className="lp-s-dots"><span /><span data-on /><span /></div>
      <div className="lp-s-headline lp-s-headline-sm">Who's coming along?</div>
      <div className="lp-s-dim lp-s-sub">Pick a plan. Switch any time.</div>
      <div className="lp-s-plans">
        <Plan title="Solo" detail="Just me" price="Free" />
        <Plan title="Crew" detail="Up to 8 travellers" price="$6/mo" chosen />
        <Plan title="Group" detail="Unlimited, shared wallet" price="$14/mo" />
      </div>
      <span className="lp-s-button">Continue</span>
    </div>
  ),
  stats: (
    <div className="lp-s lp-s-pad lp-s-dark">
      <div className="lp-s-head"><span className="lp-s-faded">Portfolio</span><span className="lp-s-avatar" /></div>
      <div className="lp-s-balance lp-s-num">$48,210.55</div>
      <div className="lp-s-gain">+$1,132.08 (2.4%) today</div>
      <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="lp-s-chart" aria-hidden>
        <path d="M0 32 L10 28 L20 30 L30 22 L40 24 L50 16 L60 19 L70 11 L80 13 L90 6 L100 8 L100 40 L0 40 Z" className="lp-s-chart-fill" />
        <path d="M0 32 L10 28 L20 30 L30 22 L40 24 L50 16 L60 19 L70 11 L80 13 L90 6 L100 8" className="lp-s-chart-line" vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="lp-s-ranges"><span data-on>1D</span><span>1W</span><span>1M</span><span>1Y</span></div>
      <div className="lp-s-tickers">
        <div className="lp-s-line"><span className="lp-s-strong">NVDA</span><span className="lp-s-up lp-s-num">+3.1%</span></div>
        <div className="lp-s-line"><span className="lp-s-strong">AAPL</span><span className="lp-s-up lp-s-num">+0.8%</span></div>
        <div className="lp-s-line"><span className="lp-s-strong">TSLA</span><span className="lp-s-down lp-s-num">−1.2%</span></div>
      </div>
      <span className="lp-s-button lp-s-on-dark">Trade</span>
    </div>
  ),
};

/** A comment pin: an ink teardrop holding the author's avatar. */
export function Pin({ initial = "M", color = "#7cb7e8", active = false, className }: { initial?: string; color?: string; active?: boolean; className?: string }) {
  return (
    <span className={`lp-pin key-primary${active ? " lp-pin-active" : ""}${className ? ` ${className}` : ""}`}>
      <span style={{ background: color }}>{initial}</span>
    </span>
  );
}

/** A person's live cursor with their name. */
export function Cursor({ name, color }: { name?: string; color: string }) {
  return (
    <span className="lp-cursor" style={{ color }}>
      <svg viewBox="0 0 18 18" width="18" height="18" aria-hidden><path d="M2 1.5 L15.5 8.6 L9.3 10 L6.4 16 Z" fill="currentColor" stroke="#0b0b0c" strokeWidth="1.2" strokeLinejoin="round" /></svg>
      {name && <span style={{ background: color }}>{name}</span>}
    </span>
  );
}

/** A member's round initial in their presence color. */
export function Face({ initial, color, className }: { initial: string; color: string; className?: string }) {
  return <span className={className ? `lp-face ${className}` : "lp-face"} style={{ background: color }}>{initial}</span>;
}
