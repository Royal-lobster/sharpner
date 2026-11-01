/**
 * Writes a screen's former theme selection into its HTML, for the migration that removed theme
 * switching. Matches what the old document theme script did to the document roots: `data-theme`,
 * a `dark`/`light` class, and the color scheme on <html>. Authored theme wrappers inside the body
 * are left alone; screens were told to keep their roots unthemed.
 */
export function bakeTheme(source: string, theme: string): string {
  if (/^\s*(<!doctype|<html)/i.test(source)) {
    let html = source.replace(/<html\b[^>]*>/i, (tag) => retag(tag, theme, true));
    html = /<body\b[^>]*>/i.test(html) ? html.replace(/<body\b[^>]*>/i, (tag) => retag(tag, theme, false)) : html;
    return html;
  }
  return `${retag("<html>", theme, true)}<body${attributes(theme, false, "", "")}>${source}</body></html>`;
}

const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

function attribute(tag: string, name: string): string {
  const match = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match ? match[1] ?? match[2] ?? match[3] ?? "" : "";
}

function attributes(theme: string, root: boolean, classes: string, style: string): string {
  const named = theme === "dark" || theme === "light";
  const list = [...classes.split(/\s+/).filter((c) => c && c !== "dark" && c !== "light"), ...(named ? [theme] : [])];
  const scheme = root && named ? `color-scheme:${theme}` : "";
  // Replace a color scheme baked earlier, so baking is idempotent.
  const kept = root && named ? style.split(";").filter((d) => !/^\s*color-scheme\s*:/i.test(d)).join(";") : style;
  const styles = [kept.trim().replace(/;?\s*$/, ""), scheme].filter(Boolean).join(";");
  return ` data-theme="${escape(theme)}"` + (list.length ? ` class="${escape(list.join(" "))}"` : "") + (styles ? ` style="${escape(styles)}"` : "");
}

function retag(tag: string, theme: string, root: boolean): string {
  const name = /^<(\w+)/.exec(tag)![1]!;
  const classes = attribute(tag, "class"), style = attribute(tag, "style");
  const rest = tag.slice(name.length + 1, -1).replace(/\s(?:data-theme|class|style)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "").trimEnd();
  return `<${name}${rest}${attributes(theme, root, classes, style)}>`;
}
