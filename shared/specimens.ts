/** Presentation for design-system nodes; component definitions themselves stay untouched. */
import { themeLabel, themeNames } from "./themes";

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export const tokenNames = (css: string) => [...new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map((m) => m[1]!))];

export function componentName(name: string) {
  const parts = name.split("/").map((part) => part.trim()).filter(Boolean);
  return { family: parts[0] || "Component", variant: parts.length > 1 ? parts.slice(1).join(" / ") : "Default" };
}

/** Props share the exact placeholder grammar used by component expansion. */
export function componentProps(source: string) {
  const props = new Map<string, Set<string>>();
  for (const match of source.matchAll(/\{\{\s*([\w-]+)\s*(?:\|([^}]*))?\}\}/g)) {
    const name = match[1]!;
    const values = props.get(name) ?? new Set<string>();
    values.add((match[2] ?? "").trim());
    props.set(name, values);
  }
  return [...props].map(([name, values]) => ({ name, defaults: [...values] }));
}

/*
 * A component is shown as itself: on its design system's own background, with room to breathe and one
 * quiet line naming its tag and props. The canvas label already names it, so there is no card chrome.
 */
const componentStyles = `<style>
.sp-component{box-sizing:border-box;display:flex;flex-direction:column;min-height:0;background:var(--color-background,#fff);color:var(--color-foreground,#242822);font:16px/1.5 var(--font-sans,ui-sans-serif,system-ui,sans-serif)}
.sp-component *{box-sizing:border-box}
.sp-component-stage{display:grid;flex:1;place-items:center;min-height:120px;padding:40px 28px}
.sp-component-instance{display:grid;place-items:center;min-width:0;max-width:100%;width:100%}
.sp-component-spec{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 14px;padding:12px 16px 14px;border-top:1px solid rgb(128 128 128/.16);font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;opacity:.6}
.sp-component-tag{overflow-wrap:anywhere;font-weight:600}
.sp-component-prop{overflow-wrap:anywhere}
.sp-component-prop em{font-style:normal;opacity:.75}
.sp-component--fixed{height:100vh;min-height:0}
.sp-component--fixed .sp-component-stage{min-height:0;overflow:hidden}
.sp-component--compact .sp-component-stage{padding:8px 10px}
</style>`;

export function componentSpecimen(name: string, tag: string, source: string, height?: number | null, theme?: string | null) {
  const { family, variant } = componentName(name);
  const fixed = typeof height === "number";
  const compact = fixed && height < 220;
  const props = componentProps(source);
  const slot = /<slot[\s/>]/i.test(source);
  const propItems = props.map(({ name, defaults }) => {
    const value = defaults.length > 1 ? "multiple defaults" : defaults[0] ? `"${defaults[0]}"` : "empty";
    return `<span class="sp-component-prop">${escape(name)} <em>${escape(value)}</em></span>`;
  });
  if (slot) propItems.push('<span class="sp-component-prop">slot <em>accepts content</em></span>');
  // A theme override is the same component in another theme, so it names that theme rather than a new variant.
  if (theme) propItems.unshift(`<span class="sp-component-prop">theme <em>${escape(themeLabel(theme))}</em></span>`);
  return `${componentStyles}<article class="sp-component${fixed ? " sp-component--fixed" : ""}${compact ? " sp-component--compact" : ""}" aria-label="${escape(`${family} / ${variant} component${theme ? `, ${themeLabel(theme)} theme` : ""}`)}">
<div class="sp-component-stage"><div class="sp-component-instance"><${tag} data-sharpner-definition="${escape(theme ?? "")}"></${tag}></div></div>
${compact ? "" : `<footer class="sp-component-spec"><code class="sp-component-tag">&lt;${escape(tag)}&gt;</code>${propItems.join("")}</footer>`}
</article>`;
}

const foundationStyles = `<style>
.sp-foundations{box-sizing:border-box;overflow:hidden;background:var(--color-background,#fafbf8);color:var(--color-foreground,#242822);font:13px/1.5 ui-sans-serif,system-ui,sans-serif}
.sp-foundations *{box-sizing:border-box}
.sp-foundations-header{display:flex;flex-wrap:wrap;align-items:baseline;justify-content:space-between;gap:16px;padding:28px 28px 0}
.sp-foundations h1{margin:0;min-width:0;font-size:22px;font-weight:650;letter-spacing:-.03em;line-height:1.2;overflow-wrap:anywhere}
.sp-foundations-count{font-size:12px;opacity:.55;font-variant-numeric:tabular-nums}
.sp-themes{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr))}
.sp-theme{min-width:0;padding:26px 28px;background:var(--color-background,#fafbf8);color:var(--color-foreground,#242822)}
.sp-theme+.sp-theme{border-inline-start:1px solid rgb(128 128 128/.2)}
.sp-theme-title{display:flex;align-items:center;gap:7px;margin:0 0 26px;font-size:11px;font-weight:600;opacity:.6}
.sp-theme-title:before{content:"";width:7px;height:7px;border:1px solid currentColor;border-radius:50%}
.sp-theme.dark .sp-theme-title:before{background:currentColor}
.sp-token-section{margin:0 0 30px}.sp-token-section:last-child{margin-bottom:0}
.sp-token-section h2{display:flex;align-items:center;gap:8px;margin:0 0 14px;font-size:16px;font-weight:650;letter-spacing:-.02em}
.sp-token-count{font-size:10px;font-weight:500;opacity:.4;font-variant-numeric:tabular-nums}
.sp-token-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,136px),1fr));gap:18px 14px}
.sp-token{min-width:0}
.sp-token-name{display:block;margin-top:9px;overflow-wrap:anywhere;font:550 12px/1.4 ui-monospace,monospace;opacity:.8}
.sp-token-value{display:block;margin-top:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:11px/1.4 ui-monospace,monospace;opacity:.5}
.sp-color{height:70px;border-radius:9px;box-shadow:inset 0 0 0 1px rgb(128 128 128/.2);background-image:linear-gradient(45deg,#8881 25%,transparent 25%),linear-gradient(-45deg,#8881 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#8881 75%),linear-gradient(-45deg,transparent 75%,#8881 75%);background-size:12px 12px;background-position:0 0,0 6px,6px -6px,-6px 0}
.sp-color-fill{height:100%;border-radius:inherit}
.sp-type-grid{grid-template-columns:repeat(auto-fill,minmax(min(100%,220px),1fr))}
.sp-type{overflow:hidden;border-bottom:1px solid rgb(128 128 128/.2);padding:12px 0 18px;font-size:34px;line-height:1.15;letter-spacing:-.025em}
.sp-size{display:flex;align-items:baseline;min-height:56px;overflow:hidden;line-height:1.1}
.sp-radius-stage,.sp-shadow-stage{display:grid;place-items:center;height:82px;border-radius:10px;background:rgb(128 128 128/.05);border:1px solid rgb(128 128 128/.08)}
.sp-radius{width:54px;height:54px;background:rgb(128 128 128/.16);border:1px solid rgb(128 128 128/.2)}
.sp-shadow{width:68px;height:46px;border-radius:8px;background:var(--color-card,var(--color-background,#fff));border:1px solid rgb(128 128 128/.1)}
.sp-space-stage{display:flex;align-items:center;height:54px;border-bottom:1px solid rgb(128 128 128/.2)}
.sp-space{min-width:2px;max-width:100%;height:12px;border-radius:2px;background:var(--color-primary,currentColor);opacity:.6}
.sp-weight{font-size:27px;line-height:1.1;padding:10px 0}
.sp-empty{padding:40px 0;opacity:.6;max-width:420px;font-size:14px}
.sp-empty code{font:12px ui-monospace,monospace}
@media(max-width:600px){.sp-foundations-header{padding:22px}.sp-theme{padding:22px}.sp-theme+.sp-theme{border-inline-start:0;border-top:1px solid rgb(128 128 128/.2)}}
</style>`;

/** Resolve labels in the specimen's own theme after Tailwind has installed the token CSS. */
const tokenValueScript = `<script>(()=>{
const update=()=>{for(const label of document.querySelectorAll("[data-sp-value]")){const name=label.getAttribute("data-sp-value");const value=getComputedStyle(label).getPropertyValue("--"+name).trim();if(value){label.textContent=value;label.title=value}}};
update();setTimeout(update,50);addEventListener("load",()=>{update();setTimeout(update,50)},{once:true});
const observer=new MutationObserver(update);observer.observe(document.head,{childList:true,subtree:true,characterData:true});setTimeout(()=>observer.disconnect(),1000);
})()</script>`;

/** The CSS remains the source of truth, including aliases and per-theme overrides. */
export function tokenSpecimen(css: string, title = "Design tokens") {
  const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const names = tokenNames(declarations);
  const firstValues = new Map<string, string>();
  for (const match of declarations.matchAll(/--([\w-]+)\s*:\s*([^;}]+)/g)) if (!firstValues.has(match[1]!)) firstValues.set(match[1]!, match[2]!.trim());
  const group = (prefix: string) => names.filter((name) => name.startsWith(prefix));
  const meta = (name: string) => `<code class="sp-token-name">${escape(name)}</code><span class="sp-token-value" data-sp-value="${escape(name)}">${escape(firstValues.get(name) ?? "")}</span>`;
  const item = (name: string, specimen: string) => `<div class="sp-token">${specimen}${meta(name)}</div>`;
  const row = (heading: string, items: string[], type = "") => items.length ? `<section class="sp-token-section"><h2>${heading}<span class="sp-token-count">${items.length}</span></h2><div class="sp-token-grid ${type}">${items.join("")}</div></section>` : "";
  const sections = [
    row("Color", group("color-").map((name) => item(name, `<div class="sp-color"><div class="sp-color-fill" style="background:var(--${name})"></div></div>`))),
    row("Typography", group("font-").filter((name) => !name.startsWith("font-weight-")).map((name) => item(name, `<div class="sp-type" style="font-family:var(--${name})">The quick<br>brown fox.</div>`)), "sp-type-grid"),
    row("Type scale", group("text-").filter((name) => !name.includes("--")).map((name) => item(name, `<div class="sp-size" style="font-size:var(--${name})">Aa</div>`))),
    row("Font weight", group("font-weight-").map((name) => item(name, `<div class="sp-weight" style="font-weight:var(--${name})">Aa Bb</div>`))),
    row("Spacing", names.filter((name) => name === "spacing" || name.startsWith("spacing-")).map((name) => item(name, `<div class="sp-space-stage"><div class="sp-space" style="width:var(--${name})"></div></div>`))),
    row("Radius", group("radius-").map((name) => item(name, `<div class="sp-radius-stage"><div class="sp-radius" style="border-radius:var(--${name})"></div></div>`))),
    row("Shadow", group("shadow-").map((name) => item(name, `<div class="sp-shadow-stage"><div class="sp-shadow" style="box-shadow:var(--${name})"></div></div>`))),
  ].filter(Boolean);
  const themes = themeNames(css);
  const sheet = sections.join("") || '<p class="sp-empty">Give this system its first decisions.<br>Declare named tokens in an <code>@theme { … }</code> block.</p>';
  const pane = (theme: string) => `<div class="sp-theme${theme === "dark" ? " dark" : ""}" data-theme="${escape(theme)}">${themes.length > 1 ? `<p class="sp-theme-title">${escape(themeLabel(theme))}</p>` : ""}${sheet}</div>`;
  return `${foundationStyles}<article class="sp-foundations"><header class="sp-foundations-header"><h1>${escape(title)}</h1><span class="sp-foundations-count">${names.length} ${names.length === 1 ? "token" : "tokens"}${themes.length > 1 ? ` · ${themes.length} themes` : ""}</span></header><div class="sp-themes">${themes.map(pane).join("")}</div></article>${tokenValueScript}`;
}
