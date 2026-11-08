import puppeteer from "@cloudflare/puppeteer";
import { withTimeout } from "./render";

type Browser = Awaited<ReturnType<typeof puppeteer.launch>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

/**
 * Reconnects to the session the previous automatic turn left warm, when it still answers; otherwise launches a
 * browser that Browser Run closes after `keepAliveMs` idle, in case Sharpner does not. A launch costs one to two seconds in production.
 * Only a session Sharpner itself left is reused, never another idle session on the account.
 */
export async function openBrowser(endpoint: Parameters<typeof puppeteer.launch>[0], warm: string | undefined, keepAliveMs: number): Promise<{ browser: Browser; reused: boolean }> {
  if (warm) {
    try {
      return { browser: await withTimeout(puppeteer.connect(endpoint, warm), 5000, "browser connect"), reused: true };
    } catch (err) {
      console.warn("thumbnail browser reconnect failed", String(err));
    }
  }
  return { browser: await puppeteer.launch(endpoint, { keep_alive: keepAliveMs }), reused: false };
}

/**
 * Opens a tab in a browser context of its own. Puppeteer serializes screenshots per context and brings the
 * capturing tab to the front of its window, so tabs sharing one context take turns capturing; in their own
 * contexts they capture in parallel. Falls back to the shared context when contexts are unavailable.
 */
export async function openTab(browser: Browser): Promise<Page> {
  try {
    return await (await browser.createBrowserContext()).newPage();
  } catch (err) {
    console.warn("thumbnail browser context failed", String(err));
    return browser.newPage();
  }
}

/**
 * With `keep`, closes this turn's pages and disconnects, leaving the browser running for the next turn; returns its
 * session. Otherwise the browser closes, which ends its billed time. Callers pass `keep` only for a healthy browser
 * (no timed-out session or wedged page); one whose pages will not close closes too.
 */
export async function releaseBrowser(browser: Browser, pages: Page[], keep: boolean): Promise<string | undefined> {
  if (keep) {
    try {
      // A tab's own context closes with its pages; a tab in the shared context closes alone.
      await withTimeout(Promise.all(pages.map((page) => {
        const context = page.browserContext?.();
        return context && context !== browser.defaultBrowserContext() ? context.close() : page.close();
      })), 5000, "page close");
      const session = browser.sessionId();
      await browser.disconnect();
      return session;
    } catch (err) {
      console.warn("thumbnail browser release failed", String(err));
    }
  }
  await withTimeout(browser.close(), 5000, "browser close").catch(() => {});
  return undefined;
}

/** Closes a session a turn left running, when it still answers. */
export async function closeBrowser(endpoint: Parameters<typeof puppeteer.launch>[0], session: string): Promise<void> {
  try {
    const browser = await withTimeout(puppeteer.connect(endpoint, session), 5000, "browser connect");
    await withTimeout(browser.close(), 5000, "browser close");
  } catch (err) {
    console.warn("thumbnail browser close failed", String(err));
  }
}
