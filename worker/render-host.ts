import type { BrowserWorker } from "@cloudflare/puppeteer";

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
