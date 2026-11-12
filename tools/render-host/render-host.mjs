#!/usr/bin/env node
// A render host lends this machine's Chrome to a Sharpner deployment, so its previews and screenshots cost no
// Browser Run time while this runs. It only dials out: one WebSocket per idle browser to the deployment, which
// then drives that browser over the socket. Each browser serves one session and is replaced. See README.md.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const origin = process.env.SHARPNER_ORIGIN;
// The token arrives on an open descriptor (the container) or in a file, so it is in no environment a browser's
// processes could read. RENDER_HOST_TOKEN is for a quick local run only.
const token = (process.env.RENDER_HOST_TOKEN_FD ? readFileSync(Number(process.env.RENDER_HOST_TOKEN_FD), "utf8")
  : process.env.RENDER_HOST_TOKEN_FILE ? readFileSync(process.env.RENDER_HOST_TOKEN_FILE, "utf8")
  : process.env.RENDER_HOST_TOKEN ?? "").trim();
delete process.env.RENDER_HOST_TOKEN;
const chrome = process.env.CHROME_BIN ?? "chromium";
const pool = Math.max(1, Number(process.env.RENDER_HOST_POOL ?? 2));
/** A session longer than any turn or screenshot can run means the deployment lost track of it. */
const SESSION_MS = 5 * 60_000;
/** An idle browser is replaced now and then, so none grows stale. */
const PARKED_MS = 6 * 60 * 60_000;
const PING_MS = 30_000;

if (!origin || !/^https?:\/\//.test(origin) || !token) {
  console.error("Set SHARPNER_ORIGIN (https://…) and RENDER_HOST_TOKEN_FILE (or RENDER_HOST_TOKEN_FD).");
  process.exit(2);
}
// Only loopback may be plain HTTP: the token and every document travel on this connection.
if (origin.startsWith("http://") && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) {
  console.error("SHARPNER_ORIGIN must be https unless it is this machine.");
  process.exit(2);
}
const socketUrl = `${origin.replace(/^http/, "ws").replace(/\/$/, "")}/api/render-host/socket`;
const log = (slot, message) => console.log(`${new Date().toISOString()} slot ${slot} ${message}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chrome runs as another user when RENDER_HOST_CHROME_USER names one (the container does), so nothing in the
 * browser can read this process, which holds the token. `setpriv` drops every capability on the way.
 */
const chromeUser = process.env.RENDER_HOST_CHROME_USER;
const asChromeUser = (command, args) => chromeUser
  ? ["setpriv", [`--reuid=${chromeUser}`, `--regid=${chromeUser}`, "--clear-groups", "--inh-caps=-all", "--ambient-caps=-all", "--bounding-set=-all", "--no-new-privs", command, ...args]]
  : [command, args];

/**
 * Starts a headless Chrome with a profile of its own. It is driven over a pipe, not a debugging port, so nothing
 * on this machine, and no page the browser loads, can find a DevTools socket to connect to.
 */
function launch(profile) {
  const [command, args] = asChromeUser(chrome, [
    "--headless=new", "--remote-debugging-pipe", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update",
    "--disable-sync", "--disable-extensions", "--disable-default-apps", "--disable-breakpad", "--disable-crash-reporter",
    "--mute-audio", "--hide-scrollbars", "--disable-dev-shm-usage", "--password-store=basic", "--use-mock-keychain",
    // Several tabs render at once and only one is in front: none may be throttled as a background tab.
    "--disable-renderer-backgrounding", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-hang-monitor", "--disable-ipc-flooding-protection",
    // The colours Browser Run captures.
    "--force-color-profile=srgb",
    ...(process.env.CHROME_FLAGS ?? "").split(/\s+/).filter(Boolean), "about:blank",
  ]);
  // Chrome gets no part of this process's environment beyond what it needs to start. It reads commands on its
  // descriptor 3 and writes replies and events on 4, each message ended by a zero byte.
  const child = spawn(command, args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH ?? "", HOME: profile, TMPDIR: tmpdir(), FONTCONFIG_PATH: process.env.FONTCONFIG_PATH ?? "/etc/fonts" },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const [input, output] = [child.stdio[3], child.stdio[4]];
  input.on("error", () => {});
  let pending = [];
  const browser = {
    onmessage: null,
    send: (message) => { if (!input.destroyed) input.write(`${message}\0`); },
    /** Resolves once Chrome answers a first command, and rejects when it exits before that. */
    ready: () => new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${stderr.slice(-400)}`)), 20_000);
      child.once("exit", (code) => { clearTimeout(timer); reject(new Error(`Chrome exited (${code}): ${stderr.slice(-400)}`)); });
      browser.onmessage = (message) => { if (message.includes('"id":0')) { clearTimeout(timer); browser.onmessage = null; resolve(); } };
      browser.send(JSON.stringify({ id: 0, method: "Browser.getVersion" }));
    }),
  };
  output.on("data", (chunk) => {
    for (let start = 0, end = chunk.indexOf(0); ; end = chunk.indexOf(0, start)) {
      if (end < 0) { pending.push(chunk.subarray(start)); break; }
      pending.push(chunk.subarray(start, end));
      const message = Buffer.concat(pending).toString("utf8");
      pending = [];
      browser.onmessage?.(message);
      start = end + 1;
    }
  });
  return { child, browser };
}

/** Every Chrome this process started and its profile, so none outlives it. */
const children = new Set(), profiles = new Set();
process.on("exit", () => {
  for (const child of children) child.kill("SIGKILL");
  for (const profile of profiles) try { rmSync(profile, { recursive: true, force: true }); } catch { /* another user's, in a container that is going away */ }
});

const opened = (socket) => new Promise((resolve, reject) => {
  socket.addEventListener("open", () => resolve(socket), { once: true });
  socket.addEventListener("error", (event) => reject(new Error(event.message || "WebSocket failed to open")), { once: true });
});

/** One browser: started, parked with the deployment, driven for one session, then removed with its profile. */
async function serve(slot) {
  // Chrome makes its own profile directory, as the user it runs as.
  const profile = join(tmpdir(), `sharpner-render-${randomUUID()}`);
  const { child, browser } = launch(profile);
  profiles.add(profile);
  children.add(child);
  child.once("exit", () => children.delete(child));
  let remote;
  try {
    await browser.ready();
    remote = await opened(new WebSocket(socketUrl, { headers: { authorization: `Bearer ${token}` } }));
    log(slot, "parked");
    let sessionAt = 0, messages = 0;
    const reason = await new Promise((resolve) => {
      const ping = setInterval(() => { if (!sessionAt && remote.readyState === WebSocket.OPEN) remote.send("ping"); }, PING_MS);
      const parked = setTimeout(() => { if (!sessionAt) resolve("idle browser replaced"); }, PARKED_MS);
      let deadline;
      const done = (why) => { clearInterval(ping); clearTimeout(parked); clearTimeout(deadline); resolve(why); };
      remote.addEventListener("message", (event) => {
        if (event.data === "pong" || typeof event.data !== "string") return;
        if (!sessionAt) { sessionAt = Date.now(); log(slot, "session started"); deadline = setTimeout(() => done("session outlived its limit"), SESSION_MS); }
        messages++;
        browser.send(event.data);
      });
      browser.onmessage = (message) => { if (remote.readyState === WebSocket.OPEN) remote.send(message); };
      remote.addEventListener("close", () => done("deployment closed the socket"));
      remote.addEventListener("error", () => done("deployment socket failed"));
      child.once("exit", () => done("browser exited"));
    });
    log(slot, sessionAt ? `session ended after ${Math.round((Date.now() - sessionAt) / 1000)} s, ${messages} messages: ${reason}` : `unparked: ${reason}`);
    return sessionAt > 0;
  } finally {
    try { remote?.close(); } catch { /* already closed */ }
    child.kill("SIGKILL");
    await new Promise((resolve) => child.exitCode !== null || child.signalCode ? resolve() : child.once("exit", resolve));
    // The profile belongs to the user Chrome ran as.
    const [command, args] = asChromeUser("rm", ["-rf", "--", profile]);
    await new Promise((resolve) => spawn(command, args, { stdio: "ignore" }).once("exit", resolve).once("error", resolve));
    profiles.delete(profile);
  }
}

async function slot(n) {
  for (let failures = 0; ;) {
    try {
      await serve(n);
      failures = 0;
    } catch (error) {
      failures++;
      log(n, `failed: ${error.message}`);
    }
    // A deployment that is down or refuses the token is retried slowly.
    await sleep(failures ? Math.min(60_000, 1000 * 2 ** failures) : 250);
  }
}

console.log(`Render host for ${origin}: ${pool} browser${pool === 1 ? "" : "s"}, ${chrome}`);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
await Promise.all(Array.from({ length: pool }, (_, n) => slot(n + 1)));
