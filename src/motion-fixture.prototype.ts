import type { DesignSystem } from "../shared/types";

/** THROWAWAY: one repeatable product screen for the interaction-first runtime experiment. */
export const motionTokens = `
@theme {
  --font-sans: Inter, ui-sans-serif, system-ui, sans-serif;
  --color-background: #f7f9fc;
  --color-surface: #ffffff;
  --color-foreground: #152338;
  --color-muted: #65758a;
  --color-line: #e4eaf2;
  --color-positive: #087e64;
  --color-negative: #dc5269;
  --color-primary: #3866ed;
}
:root[data-theme="dark"],:root.dark {
  --color-background: #0d1421;
  --color-surface: #151f30;
  --color-foreground: #e8effa;
  --color-muted: #91a1b8;
  --color-line: #26344b;
  --color-positive: #4dd3b0;
  --color-negative: #ff8296;
  --color-primary: #86a7ff;
}
`;

export const motionDesign: DesignSystem = { tokens: motionTokens, components: [] };

/** Schematic cached-image stand-in for density probes; deliberately not a browser capture. */
export function motionPoster(theme: "light" | "dark"): string {
  const dark = theme === "dark";
  const bg = dark ? "#0d1421" : "#f7f9fc", panel = dark ? "#151f30" : "#ffffff";
  const fg = dark ? "#e8effa" : "#152338", muted = dark ? "#91a1b8" : "#65758a";
  const line = dark ? "#26344b" : "#e4eaf2", green = dark ? "#4dd3b0" : "#087e64";
  const primary = dark ? "#86a7ff" : "#3866ed";
  const rows = Array.from({ length: 24 }, (_, index) => `<rect x="${660 - index % 6 * 17}" y="${208 + index * 15}" width="${90 + index % 6 * 17}" height="12" fill="${index < 12 ? "#dc5269" : green}" opacity=".1"/><text x="584" y="${218 + index * 15}" font-size="9" fill="${index < 12 ? "#dc5269" : green}">684${20 + index}.00</text><text x="699" y="${218 + index * 15}" font-size="9" fill="${muted}">0.7524</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="760" viewBox="0 0 1000 760"><rect width="1000" height="760" fill="${bg}"/><g font-family="system-ui,sans-serif" fill="${fg}"><text x="28" y="49" font-size="20" font-weight="700">atlas↗</text><text x="158" y="47" font-size="12">Exchange</text><text x="249" y="47" font-size="12" fill="${muted}">Portfolio</text><text x="28" y="109" font-size="27" font-weight="650">Bitcoin / USD</text><text x="28" y="132" font-size="12" fill="${muted}">A market that moves with you.</text><g fill="${panel}" stroke="${line}"><rect x="28" y="157" width="510" height="548" rx="14"/><rect x="554" y="157" width="198" height="548" rx="14"/><rect x="768" y="157" width="204" height="548" rx="14"/></g><text x="49" y="192" font-size="12" fill="${muted}">BTC market price</text><text x="49" y="234" font-size="32" font-weight="650">$68,426.18</text><text x="49" y="258" font-size="11" fill="${green}">↗ 2.48% today</text><path d="M49 440L70 425L92 433L114 407L136 414L158 386L180 392L202 362L224 371L246 350L268 368L290 339L312 348L334 316L356 328L378 305L400 312L422 282L444 294L466 275L490 283L516 261" stroke="${green}" stroke-width="2.5" fill="none"/><path d="M49 564H516" stroke="${line}"/><text x="49" y="597" font-size="11" fill="${muted}">24h volume</text><text x="49" y="621" font-size="15">$1.42B</text><text x="300" y="597" font-size="11" fill="${muted}">Available balance</text><text x="300" y="621" font-size="15">$12,450.00</text><text x="570" y="185" font-size="12" font-weight="650">Order book</text>${rows}<text x="787" y="188" font-size="11" font-weight="650">Trade</text><text x="878" y="188" font-size="11" fill="${muted}">Deposit</text><text x="787" y="234" font-size="10" fill="${muted}">Order size · USD</text><rect x="786" y="247" width="167" height="43" rx="8" stroke="${line}" fill="${bg}"/><text x="798" y="275" font-size="17">250</text><rect x="786" y="332" width="167" height="38" rx="8" fill="${primary}"/><text x="835" y="356" font-size="11" fill="${panel}">Place order</text><path d="M786 442H953" stroke="${line}"/><text x="787" y="479" font-size="12" font-weight="650">✓ Ready</text><text x="787" y="503" font-size="10" fill="${muted}">Explore the live market.</text><text x="28" y="737" font-size="9" fill="${muted}">Schematic poster · density experiment only</text></g></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export type MotionState = {
  version: 1;
  scenario: string;
  time: number;
  playing: boolean;
  tab: "trade" | "deposit";
  amount: string;
  action: null | { kind: "trade" | "deposit"; startedAt: number; rejected: boolean };
  theme: string;
  seed: number;
  mode: "simulation" | "scheduled" | "native";
};

export type MotionCommand = {
  type: "play" | "pause" | "reset" | "seek" | "scenario" | "theme" | "input" | "action" | "restore" | "inspect" | "mode";
  time?: number;
  value?: string | number;
  scenario?: string;
  theme?: string;
  amount?: string;
  action?: string;
  state?: MotionState;
};

/** Stringified into the opaque frame. Every changing value derives from this clock and seed. */
export function motionRuntime() {
  const root = document.querySelector<HTMLElement>("[data-motion-screen]")!;
  const get = <T extends Element = HTMLElement>(name: string) => root.querySelector<T>(`[data-motion="${name}"]`)!;
  const rows = [...root.querySelectorAll<HTMLElement>("[data-book-row]")].map((row) => ({
    row, price: row.children[1]!, size: row.children[2]!, bar: row.children[0] as HTMLElement,
  }));
  const input = get<HTMLInputElement>("amount");
  const phaseLabel = get("phase");
  const detail = get("detail");
  const progress = get("progress");
  const price = get("price");
  const path = get<SVGPathElement>("chart-line");
  const area = get<SVGPathElement>("chart-area");
  const ticker = get("ticker");
  const amountLabel = get("amount-label");
  const actionButton = get<HTMLButtonElement>("submit");
  const stats = { rafCount: 0, scheduledCount: 0, ticks: 0, renders: 0, actionCount: 0, domWrites: 0, bookUpdates: 0, chartUpdates: 0, workMs: 0, maxWorkMs: 0 };
  let state: MotionState = {
    version: 1, scenario: "market", time: 0, playing: false, tab: "trade", amount: "250",
    action: null, theme: "light", seed: 731, mode: "simulation",
  };
  let raf = 0;
  let timer = 0;
  let clockReadAt: number | null = null;
  let lastBucket = -1;
  let lastPhase = "";
  const loops = [
    get("live-dot").animate([{ opacity: 0.35 }, { opacity: 1 }, { opacity: 0.35 }], { duration: 1300, iterations: Infinity }),
    get("chart-dot").animate([{ opacity: 0.4, transform: "scale(.75)" }, { opacity: 1, transform: "scale(1.2)" }, { opacity: 0.4, transform: "scale(.75)" }], { duration: 900, iterations: Infinity }),
  ];
  for (const animation of loops) animation.pause();
  let celebration: Animation | null = null;
  let flash: Animation | null = null;

  const random = (a: number, b = 0) => {
    let x = Math.imul((a + 1) ^ state.seed, 1597334677) ^ Math.imul(b + 17, 3812015801);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  };
  const quote = (bucket: number) => 68420 + Math.sin(bucket / 19) * 62 + Math.sin(bucket / 5.2) * 13 + random(bucket) * 7;
  const phase = () => {
    if (!state.action) return "ready";
    const age = state.time - state.action.startedAt;
    if (state.action.kind === "deposit") return age < 1500 ? "processing" : state.action.rejected ? "failed" : "confirmed";
    return age < 650 ? "pending" : state.action.rejected ? "rejected" : age < 1700 ? "partially filled" : "filled";
  };
  const syncAnimationTime = () => {
    for (const animation of loops) {
      animation.currentTime = state.time;
      if (state.playing) animation.play(); else animation.pause();
    }
    if (!state.playing) { celebration?.pause(); flash?.pause(); }
  };
  const text = (element: Element, value: string) => { if (element.textContent !== value) { element.textContent = value; stats.domWrites++; } };
  const renderContent = (force = false, refreshMarket = force) => {
    const bucket = Math.floor(state.time / 100);
    const currentPhase = phase();
    const changedMarket = bucket !== lastBucket;
    if (!force && !changedMarket && currentPhase === lastPhase) return;
    stats.renders++;
    if (refreshMarket || changedMarket) {
      stats.ticks++;
      const middle = quote(bucket);
      text(price, middle.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
      text(ticker, `${(state.time / 1000).toFixed(1)}s · tick ${bucket}`);
      for (let index = 0; index < rows.length; index++) {
        const entry = rows[index]!;
        const side = index < rows.length / 2 ? 1 : -1;
        const distance = Math.abs(index - rows.length / 2) + 1;
        const quantity = 0.03 + random(bucket, index) * 1.8;
        text(entry.price, (middle + side * distance * 2.5).toFixed(2));
        text(entry.size, quantity.toFixed(4));
        entry.bar.style.transform = `scaleX(${(quantity / 2).toFixed(3)})`;
        stats.domWrites++;
      }
      stats.bookUpdates++;
      const points: string[] = [];
      for (let i = 0; i < 44; i++) points.push(`${i * 10},${170 - (quote(bucket - 43 + i) - 68335) * 0.9}`);
      const line = `M${points.join(" L")}`;
      path.setAttribute("d", line);
      area.setAttribute("d", `${line} L430,214 L0,214 Z`);
      stats.domWrites += 2; stats.chartUpdates++;
      if (state.playing && changedMarket && bucket % 3 === 0) {
        flash?.cancel();
        flash = rows[Math.abs(bucket) % rows.length]!.row.animate([{ opacity: 0.45 }, { opacity: 1 }], { duration: 230 });
      }
      lastBucket = bucket;
    }
    root.dataset.phase = currentPhase;
    root.dataset.tab = state.tab;
    text(amountLabel, state.tab === "trade" ? "Order size · USD" : "Deposit amount · USD");
    text(actionButton, state.tab === "trade" ? "Place order" : "Deposit funds");
    get("trade-tab").setAttribute("aria-selected", String(state.tab === "trade"));
    get("deposit-tab").setAttribute("aria-selected", String(state.tab === "deposit"));
    text(phaseLabel, currentPhase[0]!.toUpperCase() + currentPhase.slice(1));
    const dollars = Number(state.amount) || 0;
    const success = currentPhase === "filled" || currentPhase === "confirmed";
    text(detail, !state.action ? "Explore the live market, then try a simulated order or deposit."
      : currentPhase === "failed" || currentPhase === "rejected" ? "This scenario was declined. Your balance is unchanged."
        : success ? `$${dollars.toLocaleString("en-US")} ${state.action.kind === "deposit" ? "added to your balance" : "order filled at market price"}.`
          : currentPhase === "partially filled" ? "60% filled · matching the remaining order…" : "Checking details and processing locally…");
    const elapsed = state.action ? state.time - state.action.startedAt : 0;
    progress.style.transform = `scaleX(${!state.action ? 0 : success ? 1 : Math.min(1, elapsed / (state.action.kind === "deposit" ? 1500 : 1700))})`;
    if (currentPhase !== lastPhase) {
      celebration?.cancel(); celebration = null;
      if (success && state.playing) celebration = get("status-icon").animate([
        { transform: "scale(.7) rotate(-12deg)", opacity: 0.4 },
        { transform: "scale(1.18) rotate(5deg)", opacity: 1, offset: 0.65 },
        { transform: "scale(1) rotate(0)", opacity: 1 },
      ], { duration: 450, easing: "ease-out" });
      lastPhase = currentPhase;
    }
  };
  // Measures synchronous author render work, including DOM mutations, not layout/paint or total CPU.
  const render = (force = false, refreshMarket = force) => {
    const started = performance.now();
    try { renderContent(force, refreshMarket); }
    finally {
      const elapsed = performance.now() - started;
      stats.workMs += elapsed;
      stats.maxWorkMs = Math.max(stats.maxWorkMs, elapsed);
    }
  };
  const frame = () => {
    raf = 0;
    if (!state.playing) return;
    stats.rafCount++;
    readClock();
    render();
    raf = requestAnimationFrame(frame);
  };
  const readClock = () => {
    if (clockReadAt === null) return;
    const now = performance.now();
    state.time += now - clockReadAt; clockReadAt = now;
  };
  const schedule = () => {
    // Market updates stay at 10 Hz, with an extra wake at a product-state transition if needed.
    let nextTime = (Math.floor(state.time / 100) + 1) * 100;
    if (state.action) {
      const boundaries = state.action.kind === "deposit" ? [1500] : [650, 1700];
      for (const boundary of boundaries) {
        const at = state.action.startedAt + boundary;
        if (at > state.time) nextTime = Math.min(nextTime, at);
      }
    }
    timer = window.setTimeout(() => {
      timer = 0;
      if (!state.playing || state.mode !== "scheduled") return;
      stats.scheduledCount++;
      readClock(); render(); schedule();
    }, Math.max(1, Math.ceil(nextTime - state.time)));
  };
  const pause = () => {
    const wasPlaying = state.playing;
    readClock(); clockReadAt = null;
    state.playing = false;
    if (raf) cancelAnimationFrame(raf);
    if (timer) clearTimeout(timer);
    raf = 0; timer = 0;
    if (wasPlaying && state.mode !== "native") render();
    syncAnimationTime();
  };
  const play = () => {
    if (state.playing && clockReadAt !== null) return;
    state.playing = true; clockReadAt = performance.now();
    syncAnimationTime();
    if (state.mode === "native" || state.mode === "scheduled") {
      if (state.mode === "scheduled") schedule();
    }
    else raf = requestAnimationFrame(frame);
  };
  const setTheme = (theme: string) => {
    state.theme = theme === "dark" ? "dark" : "light";
    document.documentElement.dataset.theme = state.theme;
    document.documentElement.classList.remove("dark", "light");
    document.documentElement.classList.add(state.theme);
    document.documentElement.style.colorScheme = state.theme;
  };
  const setScenario = (name: string) => {
    const playing = state.playing;
    pause();
    state.scenario = name; state.time = 0; state.amount = "250";
    state.tab = name.startsWith("deposit") ? "deposit" : "trade";
    state.action = name === "market" ? null : { kind: state.tab, startedAt: 0, rejected: /failed|rejected/.test(name) };
    input.value = state.amount;
    celebration?.cancel(); flash?.cancel();
    lastBucket = -1; lastPhase = "";
    render(true); syncAnimationTime();
    if (playing) play();
  };
  const act = (name: string) => {
    readClock();
    if (name === "reject") {
      if (state.action) state.action.rejected = true;
      else state.action = { kind: state.tab, startedAt: state.time, rejected: true };
    } else {
      state.tab = name === "deposit" ? "deposit" : "trade";
      state.action = { kind: state.tab, startedAt: state.time, rejected: false };
    }
    stats.actionCount++;
    render(true, false);
  };
  const inspect = () => {
    readClock();
    const snapshot = JSON.parse(JSON.stringify(state)) as MotionState;
    const animations = document.getAnimations();
    return {
      state: snapshot, ...snapshot, phase: phase(), ...stats,
      pendingRaf: raf !== 0,
      pendingTimer: timer !== 0,
      activeAnimations: animations.filter((animation) => animation.playState === "running").length,
      playingAnimations: animations.filter((animation) => animation.playState === "running").length,
      animationCount: animations.length,
      nodes: root.querySelectorAll("*").length,
      checksum: `${state.seed}:${Math.floor(state.time / 100)}:${phase()}:${state.amount}:${price.textContent}:${rows[0]!.size.textContent}`,
    };
  };
  const command = (message: MotionCommand) => {
    switch (message.type) {
      case "play": play(); break;
      case "pause": pause(); break;
      case "reset": setScenario(state.scenario); break;
      case "seek": {
        const playing = state.playing;
        pause(); state.time = Math.max(0, Number(message.time ?? message.value ?? 0));
        celebration?.cancel(); flash?.cancel();
        render(true); syncAnimationTime();
        if (playing) play();
        break;
      }
      case "scenario": setScenario(String(message.scenario ?? message.value ?? "market")); break;
      case "theme": setTheme(String(message.theme ?? message.value ?? "light")); break;
      case "input": state.amount = String(message.amount ?? message.value ?? ""); input.value = state.amount; render(true, false); break;
      case "action": act(String(message.action ?? message.value ?? state.tab)); break;
      case "restore": {
        const saved = message.state;
        if (!saved || saved.version !== 1) break;
        pause();
        state = { ...saved, action: saved.action ? { ...saved.action } : null, playing: false, mode: saved.mode ?? "simulation" };
        input.value = state.amount; setTheme(state.theme);
        celebration?.cancel(); flash?.cancel(); lastBucket = -1; lastPhase = "";
        render(true); syncAnimationTime();
        if (saved.playing) play();
        break;
      }
      case "inspect": break;
      case "mode": {
        const playing = state.playing;
        pause(); state.mode = message.value === "native" ? "native" : message.value === "scheduled" ? "scheduled" : "simulation";
        if (playing) play();
        break;
      }
    }
    return inspect();
  };
  get("trade-tab").addEventListener("click", () => { state.tab = "trade"; render(true, false); });
  get("deposit-tab").addEventListener("click", () => { state.tab = "deposit"; render(true, false); });
  input.addEventListener("input", () => { state.amount = input.value; render(true, false); });
  get("order-form").addEventListener("submit", (event) => { event.preventDefault(); act(state.tab); });
  get("reject").addEventListener("click", () => act("reject"));
  document.addEventListener("visibilitychange", () => { if (document.hidden) pause(); });
  (window as unknown as { sharpnerMotion: { command: typeof command } }).sharpnerMotion = { command };
  setTheme(document.documentElement.dataset.theme ?? "light");
  render(true); syncAnimationTime();
}

export function motionSource(options: { rows?: number } = {}): string {
  const count = Math.max(8, Math.min(160, Math.round(options.rows ?? 24)));
  const rows = Array.from({ length: count }, (_, index) => `<div class="book-row ${index < count / 2 ? "ask" : "bid"}" data-book-row><i></i><span>68420.00</span><span>0.5000</span></div>`).join("");
  return `<style>
*{box-sizing:border-box}html,body{height:100%;overflow:hidden}body{font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:var(--color-background,#f7f9fc);color:var(--color-foreground,#152338);font-size:13px}
[data-motion-screen]{height:100%;min-height:640px;padding:28px;display:flex;flex-direction:column;gap:22px}
.market-nav{display:flex;align-items:center;gap:28px}.market-brand{font-size:20px;font-weight:760;letter-spacing:-.7px}.market-brand b{color:var(--color-primary,#3866ed)}.market-links{display:flex;gap:22px;color:var(--color-muted,#65758a);font-size:12px}.market-links strong{color:var(--color-foreground,#152338)}.market-avatar{margin-left:auto;border:1px solid var(--color-line,#e4eaf2);border-radius:100%;width:30px;height:30px;display:grid;place-items:center;font-size:11px}
.market-header{display:flex;align-items:center;justify-content:space-between}.market-header h1{font-size:27px;line-height:1.2;letter-spacing:-1px;margin:0}.market-header p{color:var(--color-muted,#65758a);margin:6px 0 0}.market-live{display:flex;gap:7px;align-items:center;font-size:11px;color:var(--color-positive,#087e64)}.market-live i{display:block;width:6px;height:6px;border-radius:100%;background:currentColor}
.market-layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(220px,1fr) minmax(225px,1fr);gap:16px;min-height:0;flex:1}.market-panel{background:var(--color-surface,#fff);border:1px solid var(--color-line,#e4eaf2);border-radius:14px;min-width:0;overflow:hidden}.chart-panel{display:flex;flex-direction:column;padding:21px}.muted{color:var(--color-muted,#65758a)}.market-quote{font-size:32px;font-weight:650;letter-spacing:-1.5px;font-variant-numeric:tabular-nums;margin-top:8px}.market-positive{color:var(--color-positive,#087e64)}.chart-top{display:flex;justify-content:space-between;align-items:start}.chart-tag{font-size:10px;border:1px solid var(--color-line,#e4eaf2);padding:5px 8px;border-radius:6px}.market-chart{width:100%;height:225px;overflow:visible;margin:28px 0 14px}.chart-dot{transform-origin:center;transform-box:fill-box}.chart-axis{display:flex;justify-content:space-between;font-size:9px;color:var(--color-muted,#65758a)}.market-stats{display:grid;grid-template-columns:1fr 1fr;gap:22px 12px;margin-top:auto;padding-top:24px;border-top:1px solid var(--color-line,#e4eaf2)}.market-stats small{display:block;font-size:10px;color:var(--color-muted,#65758a);margin-bottom:5px}.market-stats b{font-size:13px;font-weight:600}
.book-panel{display:flex;flex-direction:column}.panel-title{font-size:12px;font-weight:650;margin:0;padding:18px 16px 12px}.book-head,.book-row{display:grid;grid-template-columns:1fr 1fr;text-align:right;position:relative;line-height:20px;font-size:10px;font-variant-numeric:tabular-nums;padding:0 16px}.book-head{color:var(--color-muted,#65758a);font-size:9px;border-bottom:1px solid var(--color-line,#e4eaf2);padding-bottom:8px;margin-bottom:5px}.book-body{overflow:hidden;flex:1;min-height:0}.book-row i{position:absolute;inset:1px 0 1px auto;width:85%;transform-origin:right;background:currentColor;opacity:.08}.book-row span{position:relative}.book-row.ask{color:var(--color-negative,#dc5269)}.book-row.bid{color:var(--color-positive,#087e64)}.book-row span:last-child{color:var(--color-muted,#65758a)}.book-footer{padding:12px 16px;font-size:9px;color:var(--color-muted,#65758a);border-top:1px solid var(--color-line,#e4eaf2);font-variant-numeric:tabular-nums}
.action-panel{display:flex;flex-direction:column;padding:18px}.action-tabs{display:grid;grid-template-columns:1fr 1fr;background:var(--color-background,#f7f9fc);padding:3px;border-radius:8px;margin-bottom:20px}.action-tabs button{border:0;background:transparent;color:var(--color-muted,#65758a);padding:8px;font:inherit;font-size:11px;border-radius:6px;cursor:pointer}.action-tabs button[aria-selected=true]{background:var(--color-surface,#fff);color:var(--color-foreground,#152338);box-shadow:0 1px 3px #00000012}.action-form label{display:block;font-size:10px;color:var(--color-muted,#65758a);margin-bottom:7px}.action-form input{width:100%;border:1px solid var(--color-line,#e4eaf2);border-radius:8px;background:var(--color-background,#f7f9fc);color:inherit;padding:11px;font:inherit;font-size:17px;outline:none}.action-form input:focus{border-color:var(--color-primary,#3866ed)}.action-summary{display:flex;justify-content:space-between;font-size:10px;margin:15px 0;color:var(--color-muted,#65758a)}.action-submit{width:100%;border:0;border-radius:8px;background:var(--color-primary,#3866ed);color:var(--color-surface,#fff);padding:12px;font:inherit;font-weight:650;font-size:11px;cursor:pointer}.action-reject{width:100%;border:1px solid var(--color-line,#e4eaf2);border-radius:8px;background:transparent;color:var(--color-muted,#65758a);padding:9px;font:inherit;font-size:10px;margin-top:8px;cursor:pointer}
.action-status{margin-top:24px;border-top:1px solid var(--color-line,#e4eaf2);padding-top:20px;min-height:145px}.status-heading{display:flex;align-items:center;gap:8px;font-size:12px;font-weight:650}.status-icon{display:grid;place-items:center;width:25px;height:25px;border-radius:100%;background:var(--color-background,#f7f9fc);color:var(--color-primary,#3866ed)}.action-status p{font-size:10px;line-height:1.65;color:var(--color-muted,#65758a);margin:10px 0}.status-track{height:3px;border-radius:3px;background:var(--color-line,#e4eaf2);overflow:hidden;margin-top:17px}.status-track i{display:block;width:100%;height:100%;background:var(--color-primary,#3866ed);transform-origin:left;transform:scaleX(0)}[data-phase=filled] .status-icon,[data-phase=confirmed] .status-icon{color:var(--color-positive,#087e64)}[data-phase=rejected] .status-icon,[data-phase=failed] .status-icon{color:var(--color-negative,#dc5269)}.action-note{font-size:9px;line-height:1.6;color:var(--color-muted,#65758a);margin-top:auto;padding-top:20px}.market-footer{display:flex;justify-content:space-between;color:var(--color-muted,#65758a);font-size:9px}
@media(max-width:760px){[data-motion-screen]{padding:18px;gap:16px}.market-links{display:none}.market-layout{grid-template-columns:minmax(0,1fr) minmax(205px,.8fr)}.book-panel{display:none}.market-quote{font-size:27px}.market-header h1{font-size:22px}}
</style>
<main data-motion-screen data-phase="ready" data-tab="trade">
<nav class="market-nav"><div class="market-brand">atlas<b>↗</b></div><div class="market-links"><strong>Exchange</strong><span>Portfolio</span><span>Activity</span></div><div class="market-avatar">AM</div></nav>
<header class="market-header"><div><h1>Bitcoin / USD</h1><p class="text-xs">A market that moves with you.</p></div><div class="market-live"><i data-motion="live-dot"></i>Simulated live market</div></header>
<section class="market-layout">
<article class="market-panel chart-panel"><div class="chart-top"><div><div class="muted text-xs">BTC market price</div><div class="market-quote">$<span data-motion="price">68,420.00</span></div><small class="market-positive">↗ 2.48% today</small></div><span class="chart-tag">1H⌄</span></div>
<svg class="market-chart" viewBox="0 0 440 220" aria-label="Bitcoin price chart"><defs><linearGradient id="motion-area" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="currentColor" stop-opacity=".2"/><stop offset="1" stop-color="currentColor" stop-opacity="0"/></linearGradient></defs><g style="color:var(--color-positive,#087e64)"><path data-motion="chart-area" fill="url(#motion-area)"/><path data-motion="chart-line" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle data-motion="chart-dot" class="chart-dot" cx="430" cy="90" r="4" fill="currentColor"/></g></svg>
<div class="chart-axis"><span>09:00</span><span>09:15</span><span>09:30</span><span>09:45</span><span>10:00</span></div><div class="market-stats"><div><small>24h volume</small><b>$1.42B</b></div><div><small>Available balance</small><b>$12,450.00</b></div><div><small>24h high</small><b>$69,104.20</b></div><div><small>24h low</small><b>$66,875.80</b></div></div></article>
<article class="market-panel book-panel"><h2 class="panel-title">Order book</h2><div class="book-head"><span>Price · USD</span><span>Size · BTC</span></div><div class="book-body">${rows}</div><div class="book-footer" data-motion="ticker">0.0s · tick 0</div></article>
<article class="market-panel action-panel"><div class="action-tabs" role="tablist" aria-label="Account action"><button type="button" role="tab" data-motion="trade-tab" aria-selected="true">Trade</button><button type="button" role="tab" data-motion="deposit-tab" aria-selected="false">Deposit</button></div><form class="action-form" data-motion="order-form"><label for="motion-amount" data-motion="amount-label">Order size · USD</label><input id="motion-amount" data-motion="amount" inputmode="decimal" autocomplete="off" value="250" aria-label="Amount"><div class="action-summary"><span>Estimated fee</span><span>$0.25</span></div><button class="action-submit" data-motion="submit" type="submit">Place order</button></form><button class="action-reject" data-motion="reject" type="button">Reject</button><div class="action-status"><div class="status-heading"><span class="status-icon" data-motion="status-icon">✓</span><span data-motion="phase">Ready</span></div><p data-motion="detail">Explore the live market, then try a simulated order or deposit.</p><div class="status-track"><i data-motion="progress"></i></div></div><p class="action-note">Demo funds only. Orders and deposits run in your local preview; no money moves.</p></article>
</section><footer class="market-footer"><span>Interaction-first prototype · deterministic market data</span><span>Sandbox account · USD</span></footer></main>
<script>(${motionRuntime.toString()})()</script>`;
}
