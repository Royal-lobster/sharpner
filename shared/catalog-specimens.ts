/**
 * Catalog specimens: what a component in a catalog section shows. Each declared theme sits side by side, and a prop
 * that lists its values (`{{size|md|sm,md,lg}}`) gets one cell per value, so a family reads as a table without
 * hand-built boards. Named examples render under the cells. Every member of a family shares one cell width and one
 * column list, so the canvas can rule the family as a table and the cells line up.
 */
import { componentName, escapeHtml } from "./specimens";

/** One authored example: a named set of prop values, optionally at its own width. */
export type ComponentExample = { name: string; props: Record<string, string>; width?: number };
/** A cell column: a theme ("" when the system declares none to compare) and the axis value it shows, if any. */
export type SpecimenColumn = { theme: string; value: string | null };
/**
 * Derived on the server for each component in a catalog. `columns` is shared by the whole family; `blank` lists the
 * columns this member has nothing for, because it lacks the family's axis prop or that value.
 */
export type Specimen = { cellWidth: number; axis: string | null; columns: SpecimenColumn[]; blank?: number[] };

/** Room around an instance inside its cell, across and down. */
export const CELL_PAD_X = 16;
export const CELL_PAD_Y = 12;
export const MAX_AXIS_VALUES = 8;
export const MAX_EXAMPLES = 8;
/** Widest a catalog specimen may render; a family whose cells would be wider keeps one default instance. */
export const MAX_SPECIMEN_WIDTH = 2400;
const VALUE_MAX = 40;

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");

/** A prop that lists its values: `{{size|md|sm,md,lg}}`. The default joins the list if it is missing. */
export type PropAxis = { name: string; def: string; values: string[] };
export function propAxes(html: string): PropAxis[] {
  const axes: PropAxis[] = [];
  for (const m of html.matchAll(/\{\{\s*([\w-]+)\s*\|([^|}]*)\|([^}]*)\}\}/g)) {
    const name = m[1]!, def = m[2]!.trim();
    if (axes.some((a) => a.name === name)) continue;
    const values = [...new Set(m[3]!.split(",").map((v) => v.trim()).filter((v) => v && v.length <= VALUE_MAX))];
    if (!values.includes(def)) values.unshift(def);
    if (values.length > 1) axes.push({ name, def, values: values.slice(0, MAX_AXIS_VALUES) });
  }
  return axes;
}

/**
 * Themes a catalog compares: Dark and Light when the token CSS declares one of them as an alternative to its
 * default, else only the default. The declared one wears its selector; the default renders as authored. Other
 * named themes are decoration for screens to opt into, so catalogs leave them out.
 */
export type SpecimenTheme = { name: string; attrs: string };
export function specimenThemes(tokens: string): SpecimenTheme[] {
  const css = stripComments(tokens);
  const declares = (theme: string) => new RegExp(String.raw`\.${theme}(?![\w-])|\[data-theme\s*=\s*["']?${theme}["']?\s*\]`).test(css);
  const attrs = (theme: string) => `data-theme="${theme}" class="${theme}" style="color-scheme:${theme}"`;
  if (declares("dark")) return [{ name: "dark", attrs: attrs("dark") }, { name: "light", attrs: declares("light") ? attrs("light") : 'style="color-scheme:light"' }];
  if (declares("light")) return [{ name: "dark", attrs: 'style="color-scheme:dark"' }, { name: "light", attrs: attrs("light") }];
  return [{ name: "", attrs: "" }];
}

/** Validates authored examples against the component's props. Throws a message an agent can act on. */
export function parseExamples(input: unknown, html: string): ComponentExample[] {
  if (input === null || input === undefined) return [];
  if (!Array.isArray(input)) throw new Error("examples must be a list of { name, props, width? }");
  if (input.length > MAX_EXAMPLES) throw new Error(`A component takes at most ${MAX_EXAMPLES} examples`);
  const props = new Set([...html.matchAll(/\{\{\s*([\w-]+)/g)].map((m) => m[1]!));
  const names = new Set<string>();
  return input.map((raw, i) => {
    const e = raw as Partial<ComponentExample> | null;
    const name = typeof e?.name === "string" ? e.name.trim().slice(0, 60) : "";
    if (!name) throw new Error(`Example ${i + 1} needs a name`);
    if (names.has(name)) throw new Error(`Two examples are named "${name}"`);
    names.add(name);
    if (!e!.props || typeof e!.props !== "object" || Array.isArray(e!.props)) throw new Error(`Example "${name}" needs props, an object of prop values`);
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(e!.props)) {
      if (!props.has(key)) throw new Error(`Example "${name}" sets ${key}, which the component does not declare as {{${key}}}`);
      if (typeof value !== "string" || value.length > 500) throw new Error(`Example "${name}": ${key} must be text of at most 500 characters`);
      out[key] = value;
    }
    const width = e!.width === undefined || e!.width === null ? undefined : Number(e!.width);
    if (width !== undefined && !(width >= 16 && width <= 2000)) throw new Error(`Example "${name}": width must be between 16 and 2000`);
    return width === undefined ? { name, props: out } : { name, props: out, width: Math.round(width) };
  });
}

/** What the catalog needs to know about a component. */
export type SpecimenSource = { id: string; name: string; width: number; source: string };

/**
 * Specimens for one catalog family, in order. A family whose names are all `Family/Row/Column` is already a table of
 * nodes, so its members only gain theme cells. Otherwise the first member that lists a prop's values sets the
 * family's axis, the other members contribute their values in order, and a member without that prop shows its
 * default in the family's default column only.
 */
export function familySpecimens(members: SpecimenSource[], themes: SpecimenTheme[], rowColumnTable: boolean): (Specimen | null)[] {
  if (!members.length) return [];
  const axesOf = members.map((m) => propAxes(m.source));
  const lead = rowColumnTable ? undefined : axesOf.flat()[0];
  const values: (string | null)[] = lead ? [] : [null];
  if (lead) for (const axes of axesOf) for (const v of axes.find((a) => a.name === lead.name)?.values ?? []) if (!values.includes(v)) values.push(v);
  if (themes.length < 2 && values.length < 2) return members.map(() => null);
  const columns = themes.flatMap((t) => values.map((value) => ({ theme: t.name, value })));
  const cellWidth = (rowColumnTable ? 0 : Math.max(...members.map((m) => m.width))) + CELL_PAD_X * 2;
  if (Math.max(...members.map((m) => m.width)) + CELL_PAD_X * 2 > MAX_SPECIMEN_WIDTH / columns.length) return members.map(() => null);
  return members.map((m, i) => {
    const own = lead && axesOf[i]!.find((a) => a.name === lead.name);
    const blank = columns.flatMap((c, k) => c.value === null || (own ? own.values.includes(c.value) : c.value === lead!.def) ? [] : [k]);
    return {
      cellWidth: rowColumnTable ? m.width + CELL_PAD_X * 2 : cellWidth,
      axis: lead && own ? lead.name : null,
      columns,
      ...(blank.length ? { blank } : {}),
    };
  });
}

/** On-canvas width of a node: a catalog specimen spans its cells. */
export const specimenWidth = (n: { width: number; specimen?: Specimen | null }) =>
  n.specimen ? n.specimen.cellWidth * n.specimen.columns.length : n.width;

const catalogStyles = `<style>
.sp-catalog{box-sizing:border-box;display:flex;flex-direction:column;font:16px/1.5 var(--font-sans,ui-sans-serif,system-ui,sans-serif)}
.sp-catalog *{box-sizing:border-box}
.sp-cells,.sp-bands{display:flex;align-items:stretch}
.sp-cell{flex:none;display:grid;align-items:center;justify-items:center;padding:${CELL_PAD_Y}px ${CELL_PAD_X}px;min-width:0;overflow:hidden;background:var(--color-background,#fff);color:var(--color-foreground,#242822)}
.sp-cell{box-shadow:inset -1px -1px 0 color-mix(in srgb,currentColor 12%,transparent)}
.sp-instance{display:flow-root;min-width:0;max-width:100%;text-align:center}
.sp-instance>*{text-align:start}
.sp-band{flex:none;display:flex;flex-wrap:wrap;align-content:flex-start;gap:16px 24px;padding:4px ${CELL_PAD_X}px ${CELL_PAD_Y + 4}px;background:var(--color-background,#fff);color:var(--color-foreground,#242822)}
.sp-example{display:flex;flex-direction:column;align-items:flex-start;gap:6px;min-width:0;max-width:100%}
.sp-example-name{font:500 11px/1.3 ui-sans-serif,system-ui,sans-serif;opacity:.55}
.sp-band-rule{flex-basis:100%;height:1px;margin:0 0 8px;background:currentColor;opacity:.12}
.sp-catalog--fixed{height:100vh}.sp-catalog--fixed .sp-cells{flex:1;min-height:0}
</style>`;

/** A theme's attributes with `style` added to (or merged into) its own style attribute. */
const themed = (attrs: string, style: string) => /style="/.test(attrs)
  ? ` ${attrs.replace(/style="([^"]*)"/, (_, own: string) => `style="${own};${style}"`)}`
  : ` ${attrs ? `${attrs} ` : ""}style="${style}"`;

const instance = (tag: string, props: Record<string, string>) =>
  `<${tag}${Object.entries(props).map(([k, v]) => ` ${k}="${escapeHtml(v)}"`).join("")}></${tag}>`;

/**
 * The document for a catalog specimen: a row of cells, one per column, each on its theme's background with the
 * instance at the component's own width, then the examples under each theme's cells. Fixed-height components keep
 * to their height and leave examples out.
 */
export function catalogSpecimen(n: { name: string; width: number; height?: number | null; examples?: ComponentExample[] | null }, tag: string, specimen: Specimen, themes: SpecimenTheme[]) {
  const { family, variant } = componentName(n.name);
  const fixed = typeof n.height === "number";
  const attrs = new Map(themes.map((t) => [t.name, t.attrs]));
  const blank = new Set(specimen.blank ?? []);
  const cells = specimen.columns.map((c, k) => {
    const inner = blank.has(k) ? "" : `<div class="sp-instance" style="width:${n.width}px">${instance(tag, specimen.axis && c.value !== null ? { [specimen.axis]: c.value } : {})}</div>`;
    return `<div class="sp-cell"${themed(attrs.get(c.theme) ?? "", `width:${specimen.cellWidth}px`)}>${inner}</div>`;
  }).join("");
  const examples = fixed ? [] : n.examples ?? [];
  const groups = [...new Set(specimen.columns.map((c) => c.theme))];
  const bands = examples.length ? `<div class="sp-bands">${groups.map((theme) => {
    const width = specimen.cellWidth * specimen.columns.filter((c) => c.theme === theme).length;
    const items = examples.map((e) => `<div class="sp-example"><div class="sp-instance" style="width:${e.width ?? n.width}px">${instance(tag, e.props)}</div><span class="sp-example-name">${escapeHtml(e.name)}</span></div>`).join("");
    return `<div class="sp-band"${themed(attrs.get(theme) ?? "", `width:${width}px`)}><span class="sp-band-rule"></span>${items}</div>`;
  }).join("")}</div>` : "";
  return `${catalogStyles}<article class="sp-catalog${fixed ? " sp-catalog--fixed" : ""}" aria-label="${escapeHtml(`${family} / ${variant} component`)}"><div class="sp-cells">${cells}</div>${bands}</article>`;
}
