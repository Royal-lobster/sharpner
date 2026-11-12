import type { BrowserWorker, Page } from "@cloudflare/puppeteer";

/**
 * A render host is a machine that lends its Chrome to this deployment, so previews and screenshots cost no Browser
 * Run time while it is connected. It dials out to `/api/render-host/socket` (see `tools/render-host`), one socket
 * per idle browser, and each socket carries that browser's DevTools protocol. The ThumbnailQueue parks the sockets
 * and pairs one with a FileRoom for a session. Nothing connects in to the host.
 *
 * The host runs authored HTML and scripts, so a deployment names the workspaces it serves: `RENDER_HOST_WORKSPACES`
 * holds their ids, or `*` for every workspace. Without it, and without `RENDER_HOST_TOKEN`, no host is used.
 */
export function hostServes(env: Partial<Pick<Env, "RENDER_HOST_TOKEN" | "RENDER_HOST_WORKSPACES">>, workspaceId: string) {
  if (!env.RENDER_HOST_TOKEN) return false;
  const served = (env.RENDER_HOST_WORKSPACES ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  return served.includes("*") || served.includes(workspaceId);
}

/** Whether `presented` is the deployment's render host token, compared without leaking where they differ. */
export async function hostToken(env: Partial<Pick<Env, "RENDER_HOST_TOKEN">>, presented: string | undefined) {
  if (!env.RENDER_HOST_TOKEN || !presented) return false;
  const digest = async (text: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
  const [a, b] = await Promise.all([digest(env.RENDER_HOST_TOKEN), digest(presented)]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i]! ^ b[i]!;
  return difference === 0;
}

/**
 * The render host as an endpoint `@cloudflare/puppeteer` can launch from. The library makes two calls to a Browser
 * Run binding: a POST that acquires a session, and a WebSocket upgrade that connects to it. The ThumbnailQueue
 * answers both from a parked host socket, so the rendering code drives a host's browser as it drives Browser Run's.
 * A launch fails when no host is free or the file's workspace is not served, and the caller uses Browser Run.
 */
export function renderHost(env: Env, fileId: string): BrowserWorker | null {
  if (!env.RENDER_HOST_TOKEN || !env.THUMBNAIL_QUEUE) return null;
  const queue = env.THUMBNAIL_QUEUE.get(env.THUMBNAIL_QUEUE.idFromName("global"));
  return {
    fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      headers.set("x-file", fileId);
      return queue.fetch(`https://render-host${url.pathname}${url.search}`, { ...init, headers });
    }) as typeof fetch,
  };
}

/** What each socket the ThumbnailQueue holds for a render host remembers across hibernation. */
export type HostSocket =
  /** A host's idle browser; `session` once a FileRoom acquired it, `attached` once that room connected. */
  | { role: "host"; session?: string; at?: number; attached?: boolean }
  /** The FileRoom's end of a session. */
  | { role: "room"; session: string };

/** A session acquired but never connected to (its room was reset, say) is given up after this long. */
export const HOST_ACQUIRE_MS = 15_000;

// ---- the host's cache: see tools/render-host/cache.mjs for the protocol ----------------

/** In a function call's arguments, stands for the string with this SHA-256; a caching host puts the string in. */
export type CachedString = { "sharpner:cached": string };
const MISSING = /sharpner:missing (\[.*\])/;

const sha256 = async (text: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
/** The hashes a caching host says it lacks, from the error it answers a call with; null for any other error. */
function missingFrom(error: unknown): string[] | null {
  const found = MISSING.exec(String((error as { message?: unknown })?.message ?? error));
  if (!found) return null;
  try { const hashes = JSON.parse(found[1]!) as unknown; return Array.isArray(hashes) ? hashes.filter((hash): hash is string => typeof hash === "string") : null; }
  catch { return null; }
}

const caching = new WeakMap<Page, Promise<boolean>>();
/**
 * Whether the browser behind `page` is a render host that keeps a cache. A caching host answers a reference to
 * a string it cannot have with the missing-strings error; Browser Run, or a host without a cache, runs the call.
 */
function cachingHost(page: Page) {
  let known = caching.get(page);
  if (!known) caching.set(page, known = page.evaluate(() => true, { "sharpner:cached": "0".repeat(64) }).then(() => false, (error) => missingFrom(error) !== null));
  return known;
}

/**
 * Sends long strings to a page on a caching render host by reference, so each travels once however many sprites,
 * turns and days need it. `ref` names a string; `call` runs a page call whose arguments hold references, and
 * when the host lacks some of them it stores those, in messages of at most `batchChars`, and runs the call again.
 * Returns null when the browser has no cache; strings then travel as they are.
 */
export async function hostCache(page: Page, batchChars: number) {
  if (!await cachingHost(page)) return null;
  const texts = new Map<string, string>();
  let sent = 0;
  return {
    /** Characters this cache actually sent: references, and the strings the host lacked. */
    get sent() { return sent; },
    async ref(text: string): Promise<CachedString> {
      const hash = await sha256(text);
      texts.set(hash, text);
      sent += hash.length;
      return { "sharpner:cached": hash };
    },
    async call<T>(run: () => Promise<T>): Promise<T> {
      try { return await run(); }
      catch (error) {
        const missing = missingFrom(error)?.filter((hash) => texts.has(hash));
        if (!missing?.length) throw error;
        let batch: Record<string, string> = {}, chars = 0;
        const store = async () => { if (chars) await page.evaluate(() => {}, { "sharpner:store": batch }); batch = {}; chars = 0; };
        for (const hash of missing) {
          const text = texts.get(hash)!;
          if (chars && chars + text.length > batchChars) await store();
          batch[hash] = text; chars += text.length; sent += text.length;
        }
        await store();
        return run();
      }
    },
  };
}
