// The render host's cache of the strings a deployment sends by reference. See README.md, "Cache".
//
// A sprite's documents share megabytes of fonts, component definitions and CSS, and every sprite needs them
// again. The deployment sends each such string once, ever: it names a string by the SHA-256 of its text, and the
// host keeps what it is given on disk. In the arguments of a `Runtime.callFunctionOn` command:
//   { "sharpner:cached": "<hash>" }          stands for the string with that hash; the host puts it in.
//   { "sharpner:store": { "<hash>": text } }  gives the host strings to keep; the host replaces it with null.
// A command that names a string the host lacks is answered by the host itself, with an error whose message is
// `sharpner:missing ["<hash>", …]`; the deployment stores those and sends the command again.
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const CACHED = "sharpner:cached", STORE = "sharpner:store", MISSING = "sharpner:missing";
const HASH = /^[0-9a-f]{64}$/;
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Strings by the hash of their text, least recently used first. A string is kept only under its own hash, so
 * nothing can be stored under another string's name. `dir` keeps them across restarts; without it they live in
 * memory only.
 */
export function createCache(dir, { diskBytes = 5 * 1024 ** 3, memoryChars = 128 * 1024 ** 2 } = {}) {
  const memory = new Map(), disk = new Map();
  let memoryUsed = 0, diskUsed = 0;
  if (dir) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const found = [];
    for (const name of readdirSync(dir)) {
      // A write that was cut short left a temporary file.
      if (!HASH.test(name)) { rmSync(join(dir, name), { force: true }); continue; }
      const stat = statSync(join(dir, name));
      found.push([name, stat.size, stat.mtimeMs]);
    }
    for (const [name, size] of found.sort((a, b) => a[2] - b[2])) { disk.set(name, size); diskUsed += size; }
  }
  const remember = (hash, text) => {
    if (memory.has(hash)) memoryUsed -= memory.get(hash).length;
    memory.delete(hash);
    memory.set(hash, text);
    memoryUsed += text.length;
    for (const [oldest, old] of memory) {
      if (memoryUsed <= memoryChars || memory.size === 1) break;
      memory.delete(oldest); memoryUsed -= old.length;
    }
  };
  const forget = (hash) => { diskUsed -= disk.get(hash) ?? 0; disk.delete(hash); rmSync(join(dir, hash), { force: true }); };
  return {
    get(hash) {
      if (!HASH.test(hash)) return undefined;
      let text = memory.get(hash);
      if (text === undefined && dir && disk.has(hash)) {
        try { text = readFileSync(join(dir, hash), "utf8"); } catch { text = undefined; }
        // A file that no longer matches its name is not the string that was asked for.
        if (text === undefined || sha256(text) !== hash) { forget(hash); return undefined; }
      }
      if (text === undefined) return undefined;
      remember(hash, text);
      if (dir && disk.has(hash)) {
        const size = disk.get(hash);
        disk.delete(hash); disk.set(hash, size);
        try { const now = new Date(); utimesSync(join(dir, hash), now, now); } catch { /* recency is best effort */ }
      }
      return text;
    },
    put(hash, text) {
      if (!HASH.test(hash) || typeof text !== "string" || sha256(text) !== hash) return false;
      remember(hash, text);
      if (dir && !disk.has(hash)) {
        const bytes = Buffer.byteLength(text, "utf8"), temporary = join(dir, `${hash}.${process.pid}.tmp`);
        try {
          writeFileSync(temporary, text, { mode: 0o600 });
          renameSync(temporary, join(dir, hash));
          disk.set(hash, bytes); diskUsed += bytes;
          for (const oldest of disk.keys()) {
            if (diskUsed <= diskBytes || disk.size === 1) break;
            forget(oldest);
          }
        } catch { rmSync(temporary, { force: true }); }
      }
      return true;
    },
    stats: () => ({ strings: dir ? disk.size : memory.size, megabytes: Math.round((dir ? diskUsed : memoryUsed) / 1024 ** 2) }),
  };
}

/**
 * What to do with a message from the deployment before the browser sees it: `forward` it, with cached strings
 * put in and stored ones taken out, or `reply` to the deployment that strings are missing. Only the arguments of
 * a function call are read, and only objects that are exactly a reference or a store; any other message, and any
 * text that merely contains those words, passes through untouched.
 */
export function rewrite(raw, cache) {
  if (!raw.includes(`"${CACHED}"`) && !raw.includes(`"${STORE}"`)) return { forward: raw };
  let message;
  try { message = JSON.parse(raw); } catch { return { forward: raw }; }
  if (message?.method !== "Runtime.callFunctionOn" || !Array.isArray(message.params?.arguments)) return { forward: raw };
  const missing = new Set();
  let changed = false, hits = 0, stored = 0;
  const only = (value, key) => { const keys = Object.keys(value); return keys.length === 1 && keys[0] === key; };
  const walk = (value) => {
    if (Array.isArray(value)) return value.map(walk);
    if (!value || typeof value !== "object") return value;
    if (only(value, CACHED) && typeof value[CACHED] === "string") {
      changed = true;
      const text = cache.get(value[CACHED]);
      if (text === undefined) { missing.add(value[CACHED]); return null; }
      hits++;
      return text;
    }
    if (only(value, STORE) && value[STORE] && typeof value[STORE] === "object") {
      changed = true;
      for (const [hash, text] of Object.entries(value[STORE])) if (cache.put(hash, text)) stored++;
      return null;
    }
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, walk(inner)]));
  };
  message.params.arguments = message.params.arguments.map((argument) => argument && typeof argument === "object" && "value" in argument ? { ...argument, value: walk(argument.value) } : argument);
  if (!changed) return { forward: raw };
  if (missing.size) {
    return { hits, stored, reply: JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: `${MISSING} ${JSON.stringify([...missing])}` } }) };
  }
  return { hits, stored, forward: JSON.stringify(message) };
}
