/**
 * Interaction states a catalog reads from a component's Tailwind variants. A component that lists no state prop still
 * styles its states, such as `hover:bg-accent`, `aria-checked:bg-primary` or `group-data-[state=checked]:opacity-100`,
 * so the catalog gives it a row per state it styles and forces that state on the row's instance: the pseudo-class
 * variants match under `data-sp-state`, and attribute variants get their attribute set on the element they test.
 */
import type { PropAxis } from "./catalog-specimens";

/** States in row order. `checked` stands for whichever on-state the component styles: checked, selected or on. */
type State = "hover" | "focus" | "pressed" | "checked" | "invalid" | "disabled";
const ORDER: State[] = ["hover", "focus", "pressed", "checked", "invalid", "disabled"];
export const MAX_STATE_ROWS = 10;

const ON = String.raw`checked|pressed|selected`;
const PATTERNS: [State, RegExp][] = [
  ["hover", /^hover$/],
  ["focus", /^focus(-visible|-within)?$/],
  ["pressed", /^active$/],
  ["checked", new RegExp(String.raw`^(checked|aria-(${ON})|data-(${ON}|on)|data-\[(${ON})(=["']?(true)?["']?)?\]|aria-\[(${ON})=["']?true["']?\]|data-\[state=["']?(checked|on|active|selected)["']?\])$`)],
  ["invalid", /^(invalid|user-invalid|aria-invalid|data-invalid|data-\[invalid(=["']?(true)?["']?)?\]|aria-\[invalid=["']?true["']?\])$/],
  ["disabled", /^(disabled|aria-disabled|data-disabled|data-\[disabled(=["']?(true)?["']?)?\]|aria-\[disabled=["']?true["']?\])$/],
];

/** A class's variants, split at colons outside brackets: `group-data-[state=checked]:opacity-100` → its one variant. */
export function classVariants(token: string): string[] {
  const parts: string[] = [];
  let depth = 0, start = 0;
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (c === "[" || c === "(") depth++;
    else if (c === "]" || c === ")") depth = Math.max(0, depth - 1);
    else if (c === ":" && depth === 0) { parts.push(token.slice(start, i)); start = i + 1; }
  }
  return parts;
}

/** The state a variant tests, if any, without its group-, peer-, in- or has- prefix or its /name. */
export function variantState(variant: string): State | null {
  if (/^not-/.test(variant)) return null;
  const bare = variant.replace(/^(group|peer|in|has)-/, "").replace(/\/[\w-]+$/, "");
  return PATTERNS.find(([, pattern]) => pattern.test(bare))?.[0] ?? null;
}

/** What a catalog calls the on-state: Tabs select, Toggles turn on, the rest check. */
const onLabel = (variants: string[]) =>
  variants.some((v) => /checked/.test(v)) ? "checked" : variants.some((v) => /selected|state=["']?active/.test(v)) ? "selected" : variants.some((v) => /pressed|-on\b|state=["']?on/.test(v)) ? "on" : "checked";

/**
 * Row values for the states a component styles, default first: `["", "hover", "focus", "checked", "checked hover",
 * "disabled"]`. Combined rows show the on-state's hover, focus and disabled looks. A state a listed prop already
 * names (a `checked` prop, or `hover` among a prop's values) is left to that prop. Null when it styles none.
 */
export function inferredStates(html: string, listed: PropAxis[] = []): string[] | null {
  const variants = [...html.matchAll(/\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)]
    .flatMap((m) => (m[1] ?? m[2]!).split(/\s+/))
    .flatMap(classVariants);
  const found = new Set(variants.map(variantState).filter((s): s is State => !!s));
  const words = new Set(listed.flatMap((a) => [a.name, ...a.values]).map((w) => w.toLowerCase()));
  const covered = (state: State) => words.has(state) || (state === "checked" && ["checked", "selected", "pressed", "on", "active"].some((w) => words.has(w)));
  const states = ORDER.filter((s) => found.has(s) && !covered(s));
  if (!states.length) return null;
  const on = onLabel(variants.filter((v) => variantState(v) === "checked"));
  const has = (s: State) => states.includes(s);
  const rows = [""];
  for (const s of states) {
    if (s === "checked") {
      rows.push(on);
      if (has("hover")) rows.push(`${on} hover`);
      if (has("focus")) rows.push(`${on} focus`);
    } else if (s === "disabled" && has("checked")) rows.push("disabled", `${on} disabled`);
    else rows.push(s);
  }
  return rows.slice(0, MAX_STATE_ROWS);
}

/**
 * Pseudo-class variants that also match inside a forced state, so `hover:` and `group-hover:` show without a pointer.
 * Selectors keep Tailwind's own specificity and order; only catalog documents with a forced state carry them.
 */
const forced = (words: string[]) => `:where(${words.map((w) => `[data-sp-state~=${w}]`).join(",")}) *`;
const ON_WORDS = ["checked", "selected", "on"];
export const stateVariantCss = [
  ["hover", ":hover", ["hover"]],
  ["focus", ":focus", ["focus"]],
  ["focus-visible", ":focus-visible", ["focus"]],
  ["focus-within", ":focus-within", ["focus"]],
  ["active", ":active", ["pressed"]],
  ["checked", ":checked", ON_WORDS],
  ["disabled", ":disabled", ["disabled"]],
  ["invalid", ":invalid", ["invalid"]],
  ["user-invalid", ":user-invalid", ["invalid"]],
].map(([name, pseudo, words]) => `@custom-variant ${name} (&:is(${pseudo}, ${forced(words as string[])}));`).join("\n") +
  `\n@custom-variant enabled (&:enabled:not(${forced(["disabled"])}));`;

/**
 * Runs in the document after a component expands with `data-sp-state`: sets the attribute each of its classes'
 * state variants tests, on the element, its `group` ancestor or its `peer` sibling, and checks or disables native
 * controls. A forced radio leaves its group first: rows and themes repeat one name, and checking one would uncheck
 * the others. Kept in sync with PATTERNS: an on-state word (checked, selected, on) forces the checked state.
 */
export const forceStateScript = String.raw`const SP_STATE=(()=>{
const P={hover:/^hover$/,focus:/^focus(-visible|-within)?$/,pressed:/^active$/,checked:${PATTERNS[3]![1]},invalid:${PATTERNS[4]![1]},disabled:${PATTERNS[5]![1]}};
const split=t=>{const p=[];let d=0,s=0;for(let i=0;i<t.length;i++){const c=t[i];if(c==="["||c==="(")d++;else if(c==="]"||c===")")d=Math.max(0,d-1);else if(c===":"&&!d){p.push(t.slice(s,i));s=i+1}}return p};
const attr=v=>{let m;if(m=/^aria-\[([\w-]+)=["']?([^"'\]]*)["']?\]$/.exec(v))return["aria-"+m[1],m[2]];if(m=/^aria-([\w-]+)$/.exec(v))return["aria-"+m[1],"true"];
if(m=/^data-\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]$/.exec(v))return["data-"+m[1],m[2]??""];if(m=/^data-([\w-]+)$/.exec(v))return["data-"+m[1],""];return null};
const near=(el,kind,name)=>{const c=name?kind+"/"+name:kind;if(kind==="group"){for(let e=el.parentElement;e;e=e.parentElement)if(e.classList.contains(c))return e;return null}
for(let e=el.previousElementSibling;e;e=e.previousElementSibling)if(e.classList.contains(c))return e;return null};
return(root,words)=>{const on=words.some(w=>w==="checked"||w==="selected"||w==="on");const want=s=>s==="checked"?on:words.includes(s);
for(const el of [root,...root.querySelectorAll("*")]){
if(on&&el.matches('input[type=checkbox],input[type=radio]')){if(el.type==="radio")el.removeAttribute("name");el.setAttribute("checked","")}
if(words.includes("disabled")&&el.matches("button,input,select,textarea,fieldset"))el.setAttribute("disabled","");
if(words.includes("invalid")&&el.hasAttribute("aria-invalid"))el.setAttribute("aria-invalid","true");
for(const t of el.classList)for(const v of split(t)){const m=/^(?:(group|peer|in|has)-)?(.+?)(?:\/([\w-]+))?$/.exec(v);if(!m||m[1]==="in"||m[1]==="has")continue;
const s=Object.keys(P).find(k=>P[k].test(m[2]));if(!s||!want(s))continue;const a=attr(m[2]);if(!a)continue;
const target=m[1]?near(el,m[1],m[3]):el;if(target)target.setAttribute(a[0],a[1])}}}})();`;
