import type { Actor } from "./types";

/** A message can tag at most this many members; each one gets a notification. */
export const MAX_MENTIONS = 20;

const boundaryBefore = (text: string, at: number) => at === 0 || /[\s([{"'“‘]/.test(text[at - 1]!);
const boundaryAfter = (text: string, at: number) => at >= text.length || !/[\p{L}\p{N}_-]/u.test(text[at]!);

/** Where `@Name` for `name` appears in `text` as a whole tag. */
function tagAt(text: string, at: number, name: string) {
  return text[at] === "@" && boundaryBefore(text, at) && text.startsWith(name, at + 1) && boundaryAfter(text, at + 1 + name.length);
}

/** The members whose `@Name` the text contains, in member order. Members who share a name are all tagged. */
export function mentionsIn<T extends { name: string }>(text: string, members: readonly T[]): T[] {
  return members.filter((m) => m.name && [...text.matchAll(/@/g)].some((match) => tagAt(text, match.index!, m.name))).slice(0, MAX_MENTIONS);
}

export type MentionSegment = { text: string; mention?: Actor };

/** Split a message body into plain text and the `@Name` tags of its mentioned members, preferring the longest name. */
export function mentionSegments(body: string, mentions: readonly Actor[] | undefined): MentionSegment[] {
  if (!mentions?.length) return [{ text: body }];
  const byLength = [...mentions].sort((a, b) => b.name.length - a.name.length);
  const segments: MentionSegment[] = [];
  let plain = 0;
  for (let at = body.indexOf("@"); at !== -1; at = body.indexOf("@", at + 1)) {
    const mention = byLength.find((m) => m.name && tagAt(body, at, m.name));
    if (!mention) continue;
    if (at > plain) segments.push({ text: body.slice(plain, at) });
    segments.push({ text: `@${mention.name}`, mention });
    plain = at + 1 + mention.name.length;
    at = plain - 1;
  }
  if (plain < body.length) segments.push({ text: body.slice(plain) });
  return segments;
}

/** The `@query` being typed at the caret, for suggestions; null when the caret is not in a tag. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret);
  const start = before.lastIndexOf("@");
  if (start === -1 || !boundaryBefore(text, start)) return null;
  const query = before.slice(start + 1);
  if (query.length > 40 || /\n/.test(query) || /\s{2}/.test(query) || /^\s/.test(query)) return null;
  return { start, query };
}

/** Members matching a typed query: a name or login that starts with it, or a later word in the name that does. */
export function mentionSuggestions<T extends { name: string; login?: string }>(members: readonly T[], query: string, limit = 6): T[] {
  const q = query.toLowerCase();
  const rank = (m: T) => {
    const name = m.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (m.login?.toLowerCase().startsWith(q)) return 1;
    if (name.split(/\s+/).some((word) => word.startsWith(q))) return 2;
    return -1;
  };
  return members.map((m) => [m, rank(m)] as const).filter(([, r]) => r >= 0)
    .sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name)).slice(0, limit).map(([m]) => m);
}

/** Replace the typed `@query` with the member's full tag, spaced from what follows; returns the new text and caret. */
export function insertMention(text: string, caret: number, start: number, name: string) {
  let rest = text.slice(caret).replace(/^[\p{L}\p{N}_-]*/u, "");
  let tag = `@${name}`;
  if (!rest || /^\s/.test(rest)) { tag += " "; rest = rest.replace(/^ /, ""); }
  return { text: text.slice(0, start) + tag + rest, caret: start + tag.length };
}
