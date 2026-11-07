/** Presentation for design-system nodes; component definitions themselves stay untouched. */
import { bakeTheme } from "./bake-theme";
import { lengthPx, tokenSheet, type FoundationToken, type SheetColor, type SheetColumn } from "./design-system";

/** Escapes text for HTML content and quoted attributes. */
export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const tokenNames = (css: string) => [...new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]!))];

export function componentName(name: string) {
  const parts = name.split("/").map((part) => part.trim()).filter(Boolean);
  return { family: parts[0] || "Component", variant: parts.length > 1 ? parts.slice(1).join(" / ") : "Default" };
}

/*
 * A component is shown as itself and nothing else: its default instance on its design system's own background,
 * with a little room above and below it. The canvas marks the node as a component (label and outline) and catalogs
 * can set variants out as a table, so the preview carries no card chrome or caption. Tag and props come from MCP.
 *
 * The instance is laid out the way a frame of the node's width lays it out: in normal flow at the full width, so
 * block roots fill it and wrap, truncate and overflow as they do where the component is used. Inline-level roots,
 * such as a button or badge, are centred on their line; the instance's own text alignment starts from the start.
 */
const componentStyles = `<style>
.sp-component{box-sizing:border-box;display:flex;min-height:0;background:var(--color-background,#fff);color:var(--color-foreground,#242822);font:16px/1.5 var(--font-sans,ui-sans-serif,system-ui,sans-serif)}
.sp-component *{box-sizing:border-box}
.sp-component-stage{display:grid;flex:1;grid-template-columns:minmax(0,1fr);align-items:center;min-width:0;padding:12px 0}
.sp-component-instance{display:flow-root;min-width:0;width:100%;text-align:center}
.sp-component-instance>*{text-align:start}
.sp-component--fixed{height:100vh}
.sp-component--fixed .sp-component-stage{min-height:0;overflow:hidden}
</style>`;

/** `dark` presents the specimen in its design system's dark theme, on the document roots like a dark screen. */
export function componentSpecimen(name: string, tag: string, height?: number | null, dark = false) {
  const { family, variant } = componentName(name);
  const fixed = typeof height === "number";
  const html = `${componentStyles}<article class="sp-component${fixed ? " sp-component--fixed" : ""}" aria-label="${escapeHtml(`${family} / ${variant} component`)}">
<div class="sp-component-stage"><div class="sp-component-instance"><${tag}></${tag}></div></div>
</article>`;
  return dark ? bakeTheme(html, "dark") : html;
}

/*
 * A token sheet is the file's Foundations: colour (shadcn's slots, then the product's additions), palette ramps,
 * typography, spacing, radius, shadow and motion, all read from its CSS. Every swatch shows each distinct theme side
 * by side, so a token appears once rather than once per theme pane. The sheet's chrome sits in its first column's
 * theme, usually Dark.
 */
const foundationStyles = `<style>
.sp-foundations{box-sizing:border-box;overflow:hidden;padding:32px 32px 40px;background:var(--color-background,#fafbf8);color:var(--color-foreground,#242822);font:13px/1.45 ui-sans-serif,system-ui,sans-serif}
.sp-foundations *{box-sizing:border-box}
.sp-foundations code{font:550 12px/1.35 ui-monospace,monospace}
.sp-head{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 32px;padding-bottom:20px;border-bottom:1px solid rgb(128 128 128/.22)}
.sp-foundations h1{margin:0;font-size:26px;font-weight:650;letter-spacing:-.025em;line-height:1.15;overflow-wrap:anywhere}
.sp-sub{margin:6px 0 0;font-size:12px;opacity:.6;font-variant-numeric:tabular-nums}
.sp-legend{display:flex;flex-wrap:wrap;gap:8px}
.sp-chip{display:flex;align-items:center;gap:7px;border:1px solid rgb(128 128 128/.25);border-radius:99px;padding:4px 11px 4px 5px;font-size:12px;font-weight:550}
.sp-chip-dot{width:16px;height:16px;border-radius:50%;background:var(--color-background,transparent);box-shadow:inset 0 0 0 1px rgb(128 128 128/.45)}
.sp-sec{margin-top:36px}
.sp-sec>h2,.sp-sec-title{display:flex;align-items:baseline;gap:8px;margin:0 0 14px;font-size:19px;font-weight:650;letter-spacing:-.02em}
.sp-n{font-size:11px;font-weight:500;opacity:.45;font-variant-numeric:tabular-nums;letter-spacing:0}
.sp-group{margin-top:20px}.sp-group:first-of-type{margin-top:0}
.sp-flow{display:flex;flex-wrap:wrap;gap:20px 12px;margin-top:16px}
.sp-flow>.sp-group{flex:0 1 calc(var(--n) * 144px - 12px);min-width:min(100%,132px);margin:0}
.sp-group>h3{display:flex;align-items:baseline;gap:8px;margin:0 0 10px;font-size:13px;font-weight:650}
.sp-divider{display:flex;align-items:baseline;gap:8px;margin:30px 0 0;padding-top:16px;border-top:1px solid rgb(128 128 128/.22);font-size:15px;font-weight:650}
.sp-swatches{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,132px),1fr));gap:14px 12px}
.sp-swatch{min-width:0}
.sp-chips{position:relative;display:grid;grid-auto-columns:1fr;grid-auto-flow:column;height:58px;border-radius:9px;overflow:hidden}
.sp-chips:after{content:"";position:absolute;inset:0;border-radius:inherit;box-shadow:inset 0 0 0 1px rgb(128 128 128/.3);pointer-events:none}
.sp-half{min-width:0;background:var(--color-background,transparent)}
.sp-fill{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;height:100%}
.sp-fill>i{display:contents}
.sp-aa{font:650 17px/1 ui-sans-serif,system-ui,sans-serif}
.sp-cr{font:600 9px/1 ui-monospace,monospace;padding:2px 3px;border-radius:3px;background:var(--color-background,#fff);color:var(--color-foreground,#000);opacity:.9;white-space:nowrap}
.sp-cr:empty{display:none}
.sp-missing .sp-chips{display:grid;place-items:center;border:1px dashed rgb(128 128 128/.4);font-size:11px;opacity:.6}.sp-missing .sp-chips:after{content:none}
.sp-missing>code{opacity:.55}
.sp-swatch>code{display:block;margin-top:7px;overflow-wrap:anywhere}
.sp-swatch>code i{font-style:normal;opacity:.5}
.sp-desc{display:block;margin-top:2px;font-size:11px;line-height:1.35;opacity:.6;overflow-wrap:anywhere}
.sp-vals{display:grid;grid-auto-columns:1fr;grid-auto-flow:column;gap:6px;margin-top:3px;font:10.5px/1.35 ui-monospace,monospace;opacity:.5}
.sp-vals span,.sp-value{display:block;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-value{font:11px/1.4 ui-monospace,monospace;opacity:.55}
.sp-same{display:block;margin-top:2px;font:10.5px/1.35 ui-monospace,monospace;opacity:.6}
.sp-note{margin:10px 0 0;padding:10px 14px;border:1px dashed rgb(128 128 128/.35);border-radius:10px;font-size:12px;opacity:.7}
.sp-ramps{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,380px),1fr));gap:16px 32px}
.sp-ramp-row{display:grid;gap:3px;margin-top:4px;align-items:center}
.sp-ramp-row b{font-size:10.5px;font-weight:500;opacity:.55;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-ramp-row span{height:24px;border-radius:4px;box-shadow:inset 0 0 0 1px rgb(128 128 128/.15)}
.sp-ramp-steps span{height:auto;box-shadow:none;text-align:center;font:10px ui-monospace,monospace;opacity:.45}
.sp-fonts{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,210px),1fr));gap:12px}
.sp-font{min-width:0;padding:16px;border:1px solid rgb(128 128 128/.2);border-radius:12px}
.sp-ag{font-size:46px;line-height:1;font-weight:650}
.sp-pangram{margin:10px 0;font-size:15px;line-height:1.3;overflow-wrap:anywhere}
.sp-row{display:grid;grid-template-columns:minmax(0,150px) minmax(0,130px) minmax(0,1fr);align-items:center;gap:6px 18px;padding:7px 0;border-bottom:1px solid rgb(128 128 128/.16)}
.sp-rows{margin-top:16px;border-top:1px solid rgb(128 128 128/.16)}
.sp-sample{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.sp-cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,120px),1fr));gap:14px 12px;margin-top:16px}
.sp-cards:first-child{margin-top:0}
.sp-weight{font-size:26px;line-height:1.15}
.sp-track{font-size:18px;line-height:1.3;white-space:nowrap;overflow:hidden}
.sp-two{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:0 40px}
.sp-space-row{display:grid;grid-template-columns:minmax(0,90px) minmax(0,1fr) minmax(0,64px);align-items:center;gap:12px;padding:4px 0}
.sp-space-bar{min-width:2px;max-width:100%;height:10px;border-radius:2px;background:var(--color-primary,currentColor);opacity:.75}
.sp-radius{height:58px;background:rgb(128 128 128/.14);border:1px solid rgb(128 128 128/.3)}
.sp-shadows{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,300px),1fr));gap:14px 16px}
.sp-shadow-stages{display:grid;grid-auto-columns:1fr;grid-auto-flow:column;gap:6px}
.sp-shadow-stage{display:grid;place-items:center;height:96px;border-radius:10px;background:var(--color-background,transparent);box-shadow:inset 0 0 0 1px rgb(128 128 128/.18)}
.sp-shadow-stage>div{width:58%;height:46px;border-radius:8px;background:var(--color-card,var(--color-background,#fff))}
.sp-motion{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,260px),1fr));gap:20px 36px}
.sp-motion h3{margin:0 0 8px;font-size:13px;font-weight:650}
.sp-dur{display:grid;grid-template-columns:minmax(0,110px) minmax(0,1fr) minmax(0,52px);align-items:center;gap:10px;padding:4px 0}
.sp-bar{height:8px;border-radius:8px;background:rgb(128 128 128/.15)}
.sp-bar>span{display:block;height:100%;border-radius:inherit;background:var(--color-primary,currentColor)}
.sp-eases{display:flex;flex-wrap:wrap;gap:14px}
.sp-ease{width:118px;min-width:0}.sp-ease svg{display:block;width:100%;height:auto;overflow:visible}
.sp-anim{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,1fr);gap:10px;padding:5px 0;border-bottom:1px solid rgb(128 128 128/.16)}
.sp-empty{padding:40px 0;opacity:.6;max-width:420px;font-size:14px}
.sp-empty code{font:12px ui-monospace,monospace}
@media(max-width:600px){.sp-foundations{padding:22px 18px 28px}.sp-row{grid-template-columns:minmax(0,1fr) auto}.sp-row .sp-sample{grid-column:1/-1}.sp-ramp-row b{font-size:9.5px}}
</style>`;

/**
 * Resolve labels in the specimen's own theme after Tailwind has installed the token CSS: `data-sp-value` reads a
 * token, `data-sp-length` the length its own column-gap resolves to, so calc() and rem read as pixels. Contrast is
 * measured by painting the theme background, the fill and the text into a 1px canvas, so color-mix(), oklch() and
 * display-p3 resolve as the browser draws them.
 */
const tokenValueScript = `<script>(()=>{
const c=document.createElement("canvas");c.width=c.height=1;const x=c.getContext("2d",{willReadFrequently:true});
const paint=(...colors)=>{x.clearRect(0,0,1,1);for(const color of ["#fff",...colors]){x.fillStyle="rgba(0,0,0,0)";x.fillStyle=color;x.fillRect(0,0,1,1)}return [...x.getImageData(0,0,1,1).data].slice(0,3)};
const lum=(rgb)=>{const [r,g,b]=rgb.map(v=>(v/=255)<=.03928?v/12.92:((v+.055)/1.055)**2.4);return .2126*r+.7152*g+.0722*b};
const update=()=>{for(const label of document.querySelectorAll("[data-sp-value]")){const name=label.getAttribute("data-sp-value");const value=getComputedStyle(label).getPropertyValue("--"+name).trim();if(value){label.textContent=value;label.title=value}}
for(const label of document.querySelectorAll("[data-sp-length]")){const px=parseFloat(getComputedStyle(label).columnGap);if(Number.isFinite(px))label.textContent=px>9999?"full":Math.round(px*100)/100+"px"}
for(const label of document.querySelectorAll("[data-sp-contrast]")){const half=label.closest(".sp-half"),fill=label.closest(".sp-fill"),text=label.previousElementSibling;if(!half||!fill||!text)continue;
const page=getComputedStyle(half).backgroundColor,bg=paint(page,getComputedStyle(fill).backgroundColor),fg=paint("rgb("+bg+")",getComputedStyle(text).color);
const a=lum(bg),b=lum(fg),r=(Math.max(a,b)+.05)/(Math.min(a,b)+.05);label.textContent=r.toFixed(1)+(r>=7?" AAA":r>=4.5?" AA":" fail")}};
update();setTimeout(update,50);addEventListener("load",()=>{update();setTimeout(update,50)},{once:true});
const observer=new MutationObserver(update);observer.observe(document.head,{childList:true,subtree:true,characterData:true});setTimeout(()=>observer.disconnect(),1000);
})()</script>`;

const PANGRAM = "Sphinx of black quartz, judge my vow · 0123456789";
const plain = (name: string) => name.slice(2);

/**
 * The CSS remains the source of truth, including aliases and per-theme overrides. Each column redeclares every
 * token in its theme, so `var()` chains resolve inside the column, whatever element the sheet declared them on, and a
 * token another theme lacks stays undefined instead of inheriting the chrome's value.
 */
export function tokenSpecimen(css: string, title = "Design tokens") {
  const sheet = tokenSheet(css);
  const { columns } = sheet;
  const names = tokenNames(css.replace(/\/\*[\s\S]*?\*\//g, ""));
  const all = [...new Set(columns.flatMap((c) => Object.keys(c.vars)))];
  const safe = (value: string) => !/[{}<;]/.test(value);
  const themeCss = columns.map((column, i) => `.sp-foundations .sp-t${i},.sp-foundations.sp-t${i}{${all.map((name) => `${name}:${column.vars[name] && safe(column.vars[name]!) ? column.vars[name] : "initial"}`).join(";")}}`).join("\n");
  const attrs = (column: SheetColumn, i: number, classes: string, style = "") => {
    const named = column.key;
    const own = named === "dark" || named === "light" ? ` ${named}` : "";
    const styles = [column.scheme ? `color-scheme:${column.scheme}` : "", style].filter(Boolean).join(";");
    return `class="${classes} sp-t${i}${own}"${named ? ` data-theme="${escapeHtml(named)}"` : ""}${styles ? ` style="${styles}"` : ""}`;
  };
  const short = (column: SheetColumn) => escapeHtml(column.label.split(" · ")[0]!);
  const value = (t: FoundationToken | null, name: string, column: SheetColumn, i: number) =>
    `<span class="sp-t${i}" data-sp-value="${escapeHtml(name)}">${escapeHtml(t?.values[column.key] ?? "—")}</span>`;
  const describe = (t: FoundationToken | null) => t ? `<span class="sp-desc">${escapeHtml(t.description || t.utility)}</span>` : "";
  const section = (heading: string, count: number | string, body: string) => `<section class="sp-sec"><h2>${heading}<span class="sp-n">${count}</span></h2>${body}</section>`;

  const swatch = (color: SheetColor) => {
    const name = `color-${color.name}`, fg = color.foreground ? `color-${color.foreground}` : null;
    const pair = color.foreground ? ` <i>/ ${escapeHtml(color.foreground === `${color.name}-foreground` ? "foreground" : color.foreground)}</i>` : "";
    if (!color.token) return `<div class="sp-swatch sp-missing"><div class="sp-chips">not declared</div><code>${escapeHtml(color.name)}${pair}</code></div>`;
    const aa = fg && color.foregroundToken ? `<i><span class="sp-aa" style="color:var(--${fg})">Aa</span><span class="sp-cr" data-sp-contrast></span></i>` : "";
    const halves = columns.map((column, i) => `<div ${attrs(column, i, "sp-half")}><div class="sp-fill" style="background-color:var(--${name})">${aa}</div></div>`).join("");
    const missingFg = fg && !color.foregroundToken ? `<span class="sp-same">${escapeHtml(color.foreground!)} not declared</span>` : "";
    const same = color.same.length ? `<span class="sp-same">same as ${escapeHtml(color.same.join(", "))}</span>` : "";
    return `<div class="sp-swatch"><div class="sp-chips">${halves}</div><code>${escapeHtml(color.name)}${pair}</code>${describe(color.token)}<div class="sp-vals">${columns.map((column, i) => value(color.token, name, column, i)).join("")}</div>${missingFg}${same}</div>`;
  };
  const colorSection = () => {
    const { slots, additions, declared, extra } = sheet.color;
    if (!declared && !extra) return "";
    const groups = slots.map((group) => {
      const total = group.items.reduce((n, c) => n + 1 + (c.foreground ? 1 : 0), 0);
      const have = group.items.reduce((n, c) => n + (c.token ? 1 : 0) + (c.foregroundToken ? 1 : 0), 0);
      const head = `<h3>shadcn · ${group.name}<span class="sp-n">${have} of ${total}</span></h3>`;
      if (!have && group.name !== "base") return `<div class="sp-group"><p class="sp-note">shadcn · ${group.name}: none of its ${total} slots is declared (${escapeHtml(group.items.flatMap((c) => c.foreground ? [c.name, c.foreground] : [c.name]).join(", "))}).</p></div>`;
      return `<div class="sp-group">${head}<div class="sp-swatches">${group.items.map(swatch).join("")}</div></div>`;
    }).join("");
    const product = additions.length ? `<h3 class="sp-divider">Product additions<span class="sp-n">${extra}</span></h3><div class="sp-flow">${additions.map((group) =>
      `<div class="sp-group" style="--n:${group.items.length}"><h3>${escapeHtml(group.name)}<span class="sp-n">${group.items.length}</span></h3><div class="sp-swatches">${group.items.map(swatch).join("")}</div></div>`).join("")}</div>` : "";
    return section("Colour", `${declared} of 32 shadcn slots${extra ? ` · ${extra} additions` : ""}`, groups + product);
  };
  const rampSection = () => {
    if (!sheet.ramps.length) return "";
    const rows = sheet.ramps.map((ramp) => {
      const template = `grid-template-columns:44px repeat(${ramp.steps.length},minmax(0,1fr))`;
      const steps = `<div class="sp-ramp-row sp-ramp-steps" style="${template}"><b></b>${ramp.steps.map((s) => `<span>${s.step}</span>`).join("")}</div>`;
      const strips = columns.map((column, i) => `<div ${attrs(column, i, "sp-ramp-row", template)}><b>${short(column)}</b>${ramp.steps.map((s) => `<span style="background:var(${s.name})" title="${escapeHtml(plain(s.name))}"></span>`).join("")}</div>`).join("");
      return `<div class="sp-ramp"><code>${escapeHtml(ramp.name)}</code>${steps}${strips}</div>`;
    }).join("");
    return section("Palette ramps", sheet.ramps.length, `<div class="sp-ramps">${rows}</div>`);
  };
  const first = (t: FoundationToken) => t.values[columns[0]!.key] ?? Object.values(t.values)[0] ?? "";
  const label = (t: FoundationToken) => `<code>${escapeHtml(plain(t.name))}</code>${describe(t)}<span class="sp-value" data-sp-value="${escapeHtml(plain(t.name))}">${escapeHtml(first(t))}</span>`;
  const typeSection = () => {
    const { fonts, weights, tracking, text, icons } = sheet;
    if (!fonts.length && !weights.length && !tracking.length && !text.length && !icons.length) return "";
    const families = fonts.length ? `<div class="sp-fonts">${fonts.map((t) => `<div class="sp-font"><div class="sp-ag" style="font-family:var(${t.name})">Ag</div><div class="sp-pangram" style="font-family:var(${t.name})">${PANGRAM}</div>${label(t)}</div>`).join("")}</div>` : "";
    const weightCards = weights.length ? `<div class="sp-cards">${weights.map((t) => `<div><div class="sp-weight" style="font-weight:var(${t.name})">Aa Bb</div>${label(t)}</div>`).join("")}</div>` : "";
    const trackingCards = tracking.length ? `<div class="sp-cards">${tracking.map((t) => `<div><div class="sp-track" style="letter-spacing:var(${t.name})">Tracking</div>${label(t)}</div>`).join("")}</div>` : "";
    const sizes = text.length ? `<div class="sp-rows">${text.map(({ token: t, lineHeight, display }) => {
      const name = plain(t.name);
      const leading = lineHeight ? ` / <span data-sp-value="${escapeHtml(plain(lineHeight.name))}">${escapeHtml(first(lineHeight))}</span>` : "";
      const family = display ? "var(--font-display)" : "var(--font-sans,inherit)";
      return `<div class="sp-row"><div><code>${escapeHtml(name)}</code>${t.description ? `<span class="sp-desc">${escapeHtml(t.description)}</span>` : ""}</div><span class="sp-value"><span data-sp-value="${escapeHtml(name)}">${escapeHtml(first(t))}</span>${leading}</span><div class="sp-sample" style="font-size:var(${t.name});${lineHeight ? `line-height:var(${lineHeight.name});` : ""}font-family:${family}${display ? ";font-weight:650" : ""}">${display ? "Display heading 64" : PANGRAM}</div></div>`;
    }).join("")}</div>` : "";
    const defaultScale = text.length ? "" : `<p class="sp-note">No <code>--text-*</code> sizes are declared, so Tailwind's default type scale applies.</p>`;
    const iconLine = icons.length ? `<p class="sp-note">Icon sizes: ${icons.map((t) => `<code>${escapeHtml(plain(t.name))}</code> <span data-sp-value="${escapeHtml(plain(t.name))}">${escapeHtml(first(t))}</span>`).join(" · ")}</p>` : "";
    return section("Typography", [fonts.length ? `${fonts.length} ${fonts.length === 1 ? "family" : "families"}` : "", text.length ? `${text.length} sizes` : ""].filter(Boolean).join(" · "), families + weightCards + trackingCards + sizes + defaultScale + iconLine);
  };
  const spacingBlock = () => {
    const { base, steps, named } = sheet.spacing;
    const unit = base ? "var(--spacing)" : "0.25rem";
    const rows = steps.map((n) => `<div class="sp-space-row"><code>${n} × spacing</code><div class="sp-space-bar" style="width:calc(${unit} * ${n})"></div><span class="sp-value" data-sp-length style="column-gap:calc(${unit} * ${n})">${n * (lengthPx(base ? first(base) : "0.25rem") ?? 4)}px</span></div>`).join("");
    const own = named.map((t) => `<div class="sp-space-row"><code>${escapeHtml(plain(t.name))}</code><div class="sp-space-bar" style="width:var(${t.name})"></div><span class="sp-value" data-sp-length style="column-gap:var(${t.name})">${escapeHtml(first(t))}</span></div>`).join("");
    const note = base ? `<p class="sp-sub">--spacing is <span data-sp-value="spacing">${escapeHtml(first(base))}</span>${base.description ? ` · ${escapeHtml(base.description)}` : ""}</p>` : `<p class="sp-note">No <code>--spacing</code> is declared, so Tailwind's 0.25rem default applies.</p>`;
    return `<div><h2 class="sp-sec-title">Spacing</h2>${note}${rows}${own}</div>`;
  };
  const radiusBlock = () => sheet.radii.length ? `<div><h2 class="sp-sec-title">Radius<span class="sp-n">${sheet.radii.length}</span></h2><div class="sp-cards">${sheet.radii.map((t) =>
    `<div><div class="sp-radius" style="border-radius:var(${t.name})"></div><code>${escapeHtml(plain(t.name))}</code>${describe(t)}<span class="sp-value" data-sp-length style="column-gap:var(${t.name})">${escapeHtml(first(t))}</span></div>`).join("")}</div></div>` : "";
  const shadowSection = () => sheet.shadows.length ? section("Shadow", sheet.shadows.length, `<div class="sp-shadows">${sheet.shadows.map((t) => {
    const stages = columns.map((column, i) => `<div ${attrs(column, i, "sp-shadow-stage")}><div style="box-shadow:var(${t.name})"></div></div>`).join("");
    return `<div><div class="sp-shadow-stages">${stages}</div><code>${escapeHtml(plain(t.name))}</code>${describe(t)}<div class="sp-vals">${columns.map((column, i) => value(t, plain(t.name), column, i)).join("")}</div></div>`;
  }).join("")}</div>`) : "";
  const motionSection = () => {
    const { durations, eases, animations } = sheet.motion;
    if (!durations.length && !eases.length && !animations.length) return "";
    const longest = Math.max(1, ...durations.map((d) => d.ms ?? 0));
    const durationBlock = durations.length ? `<div><h3>Duration</h3>${durations.map(({ token: t, ms }) => `<div class="sp-dur"><code>${escapeHtml(plain(t.name))}</code><div class="sp-bar"><span style="width:${ms === null ? 0 : Math.max(2, Math.round(ms / longest * 1000) / 10)}%"></span></div><span class="sp-value" data-sp-value="${escapeHtml(plain(t.name))}">${escapeHtml(first(t))}</span></div>`).join("")}</div>` : "";
    const easeBlock = eases.length ? `<div><h3>Easing</h3><div class="sp-eases">${eases.map(({ token: t, curve }) => `<div class="sp-ease">${curve ? easeSvg(curve) : ""}<code>${escapeHtml(plain(t.name))}</code><span class="sp-value" data-sp-value="${escapeHtml(plain(t.name))}">${escapeHtml(first(t))}</span></div>`).join("")}</div></div>` : "";
    const animationBlock = animations.length ? `<div><h3>Animation</h3>${animations.map((t) => `<div class="sp-anim"><code>${escapeHtml(plain(t.name))}</code><span class="sp-value" data-sp-value="${escapeHtml(plain(t.name))}">${escapeHtml(first(t))}</span></div>`).join("")}</div>` : "";
    return section("Motion", durations.length + eases.length + animations.length, `<div class="sp-motion">${durationBlock}${easeBlock}${animationBlock}</div>`);
  };

  const body = [colorSection(), rampSection(), typeSection(),
    `<section class="sp-sec sp-two">${spacingBlock()}${radiusBlock()}</section>`, shadowSection(), motionSection()];
  const hasTokens = sheet.tokens.length > 0;
  const content = hasTokens ? body.join("") : '<p class="sp-empty">Give this system its first decisions.<br>Declare named tokens in an <code>@theme { … }</code> block.</p>';
  const legend = columns.length > 1 ? `<div class="sp-legend">${columns.map((column, i) => `<span class="sp-chip"><span ${attrs(column, i, "sp-chip-dot")}></span>${escapeHtml(column.label)}</span>`).join("")}</div>` : "";
  const counts = `${names.length} ${names.length === 1 ? "token" : "tokens"}${columns.length > 1 ? ` · ${columns.length} themes` : ""}`;
  return `${foundationStyles}<style>${themeCss}</style><article ${attrs(columns[0]!, 0, "sp-foundations")}><header class="sp-head"><div><h1>${escapeHtml(title)}</h1><p class="sp-sub">${counts}</p></div>${legend}</header>${content}</article>${tokenValueScript}`;
}

/** An easing curve drawn in a unit square, with room for overshoot. */
function easeSvg([x1, y1, x2, y2]: [number, number, number, number]) {
  const lo = Math.min(0, y1, y2), hi = Math.max(1, y1, y2), size = 100, pad = 6;
  const px = (x: number) => (pad + x * size).toFixed(1);
  const py = (y: number) => (pad + (hi - y) / (hi - lo) * size).toFixed(1);
  return `<svg viewBox="0 0 ${size + pad * 2} ${size + pad * 2}" aria-hidden="true"><rect x="${pad}" y="${py(1)}" width="${size}" height="${(Number(py(0)) - Number(py(1))).toFixed(1)}" fill="none" stroke="currentColor" stroke-opacity=".15"/><line x1="${px(0)}" y1="${py(0)}" x2="${px(x1)}" y2="${py(y1)}" stroke="currentColor" stroke-opacity=".3"/><line x1="${px(1)}" y1="${py(1)}" x2="${px(x2)}" y2="${py(y2)}" stroke="currentColor" stroke-opacity=".3"/><path d="M${px(0)},${py(0)} C${px(x1)},${py(y1)} ${px(x2)},${py(y2)} ${px(1)},${py(1)}" fill="none" stroke="var(--color-primary,currentColor)" stroke-width="2.5"/></svg>`;
}
