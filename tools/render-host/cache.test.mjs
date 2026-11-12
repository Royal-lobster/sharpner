import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createCache, rewrite } from "./cache.mjs";

const sha = (text) => createHash("sha256").update(text, "utf8").digest("hex");
const dirs = [];
const directory = () => { const dir = mkdtempSync(join(tmpdir(), "render-host-cache-")); dirs.push(dir); return dir; };
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const call = (value, extra = {}) => JSON.stringify({ id: 7, sessionId: "page", method: "Runtime.callFunctionOn", params: { functionDeclaration: "f", arguments: [{ value }] }, ...extra });

describe("the render host's string cache", () => {
  it("keeps a string only under the hash of its own text, across restarts", () => {
    const dir = directory(), text = "Ñandú 東京 ".repeat(1000);
    const cache = createCache(dir);
    expect(cache.put(sha("another string"), text)).toBe(false);
    expect(cache.put("../../etc/passwd", text)).toBe(false);
    expect(cache.get(sha(text))).toBeUndefined();
    expect(cache.put(sha(text), text)).toBe(true);
    expect(createCache(dir).get(sha(text))).toBe(text);
    expect(readdirSync(dir)).toEqual([sha(text)]);
  });

  it("does not return a file that no longer matches its name", () => {
    const dir = directory(), text = "component definition";
    createCache(dir).put(sha(text), text);
    writeFileSync(join(dir, sha(text)), "something else");
    const cache = createCache(dir);
    expect(cache.get(sha(text))).toBeUndefined();
    expect(readdirSync(dir)).toEqual([]);
  });

  it("drops the least recently used strings past its disk limit", () => {
    const dir = directory(), strings = ["a", "b", "c"].map((letter) => letter.repeat(400));
    const cache = createCache(dir, { diskBytes: 1000, memoryChars: 1 });
    cache.put(sha(strings[0]), strings[0]);
    cache.put(sha(strings[1]), strings[1]);
    // Using the first makes the second the oldest.
    expect(cache.get(sha(strings[0]))).toBe(strings[0]);
    cache.put(sha(strings[2]), strings[2]);
    expect(readdirSync(dir).sort()).toEqual([sha(strings[0]), sha(strings[2])].sort());
    expect(cache.get(sha(strings[1]))).toBeUndefined();
  });
});

describe("messages on their way to the browser", () => {
  it("puts cached strings in, takes stored ones out, and asks for what is missing", () => {
    const cache = createCache(null), fonts = "@font-face{}".repeat(100), part = "<x-card>".repeat(100);
    const references = { parts: [{ "sharpner:cached": sha(part) }], docs: ["<p>own</p>"], fonts: { "sharpner:cached": sha(fonts) } };
    // Nothing is cached yet: the host answers the command itself.
    const first = rewrite(call(references), cache);
    expect(first.forward).toBeUndefined();
    expect(JSON.parse(first.reply)).toEqual({ id: 7, sessionId: "page", error: { code: -32000, message: `sharpner:missing ${JSON.stringify([sha(part), sha(fonts)])}` } });
    // The deployment stores them; the browser gets the call without the strings.
    const store = rewrite(call({ "sharpner:store": { [sha(part)]: part, [sha(fonts)]: fonts, [sha("x")]: "not x" } }), cache);
    expect(store.stored).toBe(2);
    expect(JSON.parse(store.forward).params.arguments).toEqual([{ value: null }]);
    // The same command now reaches the browser whole.
    const second = rewrite(call(references), cache);
    expect(second.hits).toBe(2);
    expect(JSON.parse(second.forward).params.arguments).toEqual([{ value: { parts: [part], docs: ["<p>own</p>"], fonts } }]);
  });

  it("leaves everything else exactly as sent", () => {
    const cache = createCache(null);
    cache.put(sha("secret"), "secret");
    const reference = { "sharpner:cached": sha("secret") };
    for (const raw of [
      `{"id":1,"method":"Page.navigate","params":{"url":"about:blank"}}`,
      // A document that merely contains the words, as text.
      call({ docs: [`<p>{"sharpner:cached":"${sha("secret")}"}</p>`] }),
      // A reference outside a function call's arguments.
      JSON.stringify({ id: 2, method: "Page.setDocumentContent", params: { html: reference } }),
      // An object that is more than a reference.
      call({ part: { ...reference, other: 1 } }),
      `not json "sharpner:cached"`,
    ]) expect(rewrite(raw, cache)).toEqual({ forward: raw });
  });
});
