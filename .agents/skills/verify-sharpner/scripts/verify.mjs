#!/usr/bin/env node
// verify-sharpner control CLI. Launches an isolated, production-free Sharpner, signs a
// browser in as the verification member, calls MCP tools, captures evidence, and cleans up.
// Requires Node 24+, pnpm, and the agent-browser CLI. Run `verify.mjs help` for commands.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(SKILL, "../../..");
const POINTER = path.join(REPO, ".wrangler", "verify-sharpner", "current.json");
const VERIFY_EMAIL = "sharpner-verify+clerk_test@example.com";
const VERIFY_ORG = "Sharpner Verify";
const DEFAULT_PORT = 5199;
// The browser may reach only the local app, the Clerk development instance, the Tailwind CDN that frames
// load, Google Fonts and unpkg (fonts and icon fonts that agent-authored tokens import), and Unsplash photos,
// which designs use as images. All are read-only and none is production.
const ALLOWED_DOMAINS = "127.0.0.1,localhost,*.clerk.accounts.dev,*.accounts.dev,img.clerk.com,cdn.jsdelivr.net,fonts.googleapis.com,fonts.gstatic.com,unpkg.com,images.unsplash.com";
// Restores WebSocket.OPEN and friends, which the allowlist wrapper drops. See browser-init.js.
const INIT_SCRIPT = path.join(SKILL, "scripts", "browser-init.js");
const SOCKETS_OK = "WebSocket.OPEN === 1 && WebSocket.CLOSED === 3";
const LOCAL_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost):\d+$/;

const HELP = `verify-sharpner: drive a local, isolated Sharpner the way a member and an agent do.

Usage: node .agents/skills/verify-sharpner/scripts/verify.mjs <command> [options]

  launch [--port 5199] [--run-dir DIR] [--slug NAME] [--no-browser-rendering]
                         Start an isolated instance and wait until it is usable.
  doctor                 Read-only health check. Exit 1 when the instance is unsafe or broken.
  signin                 Ensure the verification member and workspace in the Clerk
                         development instance, then sign the browser in.
  open [--viewer] <path> Open a local path (for example /f/<fileId>) in the member browser,
                         or in the signed-out viewer browser with --viewer.
  ab <args...>           Run agent-browser in the member browser session.
  viewer <args...>       Run agent-browser in a separate, signed-out viewer session.
  capture [--viewer] <feature> <label>
                         Save a screenshot, ARIA snapshot and URL under evidence/<feature>/.
  api <METHOD> <path> [json]
                         Call /api<path> as the member, with the browser's Clerk session.
  mcp-login              Connect an agent: Clerk OAuth (PKCE) approved in the member browser.
  mcp <tool> [json]      Call an MCP tool as the member's agent. "mcp --list" lists tools.
  status                 Print the current run as JSON.
  cleanup [--run-dir DIR]
                         Stop processes, close browsers, delete scratch state. Keeps evidence.

Select a run other than this checkout's current one with VERIFY_SHARPNER_RUN=<run dir>.`;

// ---------- small utilities ----------

class Failure extends Error {}
const fail = (message) => { throw new Failure(message); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const now = () => new Date().toISOString();
const writeJson = (file, value, mode) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", mode ? { mode } : undefined);
};
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
/** Hide one-time and session-binding values that Clerk puts in URLs before they reach output or evidence. */
const redact = (text) => String(text ?? "").replace(/((?:__clerk_db_jwt|__clerk_ticket|code|state|code_challenge)(?:=|%3D))[^&%\s"]+/g, "$1<redacted>");
const has = (command) => spawnSync("sh", ["-c", `command -v ${command}`], { stdio: "ignore" }).status === 0;

function flags(args, names) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const name = args[i].replace(/^--/, "");
    if (args[i].startsWith("--") && names.includes(name)) {
      const boolean = name.startsWith("no-") || name === "viewer" || name === "list";
      options[name] = boolean ? true : args[++i];
    } else rest.push(args[i]);
  }
  return { options, rest };
}

/** Strip // and /* *\/ comments and trailing commas from JSONC, respecting strings. */
function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i = text.indexOf("*/", i + 2) + 1;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** Read development Clerk settings at runtime. Secret values never leave this process except to Clerk and the child server. */
function devVars() {
  const file = path.join(REPO, ".dev.vars");
  if (!fs.existsSync(file)) fail(".dev.vars is missing. Copy .dev.vars.example and add development Clerk keys (see CONTRIBUTING.md).");
  const vars = parseEnv(fs.readFileSync(file, "utf8"));
  if (!/^pk_test_/.test(vars.CLERK_PUBLISHABLE_KEY ?? "")) fail("CLERK_PUBLISHABLE_KEY in .dev.vars is not a development key (pk_test_). Refusing to verify against a production Clerk instance.");
  if (!/^sk_test_/.test(vars.CLERK_SECRET_KEY ?? "")) fail("CLERK_SECRET_KEY in .dev.vars is not a development key (sk_test_). Refusing to verify against a production Clerk instance.");
  return vars;
}

function clerkIssuer(publishableKey) {
  const host = Buffer.from(publishableKey.replace(/^pk_(test|live)_/, ""), "base64").toString().replace(/\$$/, "");
  if (!/^[a-z0-9.-]+\.clerk\.accounts\.dev$/i.test(host)) fail("The publishable key does not name a Clerk development host (*.clerk.accounts.dev).");
  return `https://${host}`;
}

async function clerk(method, route, body) {
  const { CLERK_SECRET_KEY } = devVars();
  const response = await fetch(`https://api.clerk.com/v1${route}`, {
    method,
    headers: { authorization: `Bearer ${CLERK_SECRET_KEY}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) fail(`Clerk ${method} ${route} failed with ${response.status}: ${data?.errors?.[0]?.long_message ?? data?.errors?.[0]?.message ?? "no details"}`);
  return data;
}

// ---------- run state ----------

function runDirFromPointer() {
  if (process.env.VERIFY_SHARPNER_RUN) return path.resolve(process.env.VERIFY_SHARPNER_RUN);
  if (!fs.existsSync(POINTER)) return null;
  return readJson(POINTER).runDir;
}

function loadRun(runDir = runDirFromPointer()) {
  if (!runDir) fail("No verification run is active for this checkout. Start one with `verify.mjs launch`.");
  const file = path.join(runDir, "run.json");
  if (!fs.existsSync(file)) fail(`${file} does not exist. The run was never launched or was removed.`);
  return readJson(file);
}

const saveRun = (run) => writeJson(path.join(run.runDir, "run.json"), run);
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Processes this run started carry VERIFY_SHARPNER_RUN=<id>, including detached children such as Chrome. */
function markedProcesses(id) {
  if (process.platform !== "linux") return [];
  const marker = Buffer.from(`\0VERIFY_SHARPNER_RUN=${id}\0`);
  const pids = [];
  for (const entry of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
    try {
      const environ = Buffer.concat([Buffer.from([0]), fs.readFileSync(`/proc/${entry}/environ`), Buffer.from([0])]);
      if (environ.includes(marker)) pids.push(Number(entry));
    } catch { /* gone or not ours */ }
  }
  return pids;
}

function portListener(port) {
  if (!has("ss")) return null;
  const out = spawnSync("ss", ["-ltnpH", `sport = :${port}`], { encoding: "utf8" }).stdout ?? "";
  const pids = [...out.matchAll(/pid=(\d+)/g)].map((m) => Number(m[1]));
  return { listening: out.trim().length > 0, pids };
}

function portFree(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

function gitHead() {
  return spawnSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || null;
}

function newRunDir(slug) {
  if (has("agent-artifacts")) {
    const result = spawnSync("agent-artifacts", ["new", "sharpner", `verify-${slug}`, "--purpose", "verify-sharpner run"], { encoding: "utf8" });
    const dir = result.stdout.trim().split("\n").pop();
    if (result.status === 0 && dir && fs.existsSync(dir)) return dir;
  }
  const cache = process.env.XDG_CACHE_HOME || path.join(process.env.HOME, ".cache");
  const date = new Date();
  const day = date.toISOString().slice(0, 10);
  const stamp = date.toTimeString().slice(0, 8).replace(/:/g, "");
  return path.join(cache, "agent-artifacts", "sharpner", day, `${stamp}-verify-${slug}-${crypto.randomBytes(3).toString("hex")}`);
}

// ---------- agent-browser ----------

function browserArgs(run, viewer = false) {
  return ["--session", viewer ? `${run.session}-viewer` : run.session, "--allowed-domains", ALLOWED_DOMAINS, "--init-script", INIT_SCRIPT];
}

function ab(run, args, { viewer = false, input, quiet = false } = {}) {
  if (!has("agent-browser")) fail("agent-browser is not installed. Run `npm i -g agent-browser && agent-browser install`.");
  const result = spawnSync("agent-browser", [...browserArgs(run, viewer), ...args], { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (!quiet) { process.stdout.write(result.stdout ?? ""); process.stderr.write(result.stderr ?? ""); }
  return result;
}

/** Evaluate JavaScript in a browser session and return its JSON result. The script travels on stdin, never argv. */
function evaluate(run, script, { viewer = false } = {}) {
  const result = ab(run, ["--json", "eval", "--stdin"], { viewer, input: script, quiet: true });
  let parsed;
  try { parsed = JSON.parse(result.stdout); } catch { fail(`agent-browser eval returned no JSON: ${(result.stderr || result.stdout).slice(0, 400)}`); }
  if (!parsed.success) fail(`Browser evaluation failed: ${parsed.error}`);
  return parsed.data.result;
}

function currentUrl(run, viewer = false) {
  const result = ab(run, ["--json", "get", "url"], { viewer, quiet: true });
  try { const parsed = JSON.parse(result.stdout); return parsed.success ? parsed.data.url : null; } catch { return null; }
}

function requireLocalTarget(run, target) {
  const url = new URL(target, run.origin);
  if (url.origin !== run.origin) fail(`Refusing to open ${url.origin}. Only this run's origin (${run.origin}) is allowed.`);
  return url.href;
}

async function waitFor(run, expression, { timeout = 60_000, viewer = false, label = expression } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    try { if (evaluate(run, `(() => { try { return Boolean(${expression}); } catch { return false; } })()`, { viewer })) return; } catch { /* page navigating */ }
    await sleep(500);
  }
  fail(`Timed out after ${timeout / 1000}s waiting for ${label}.`);
}

// ---------- commands ----------

async function launch(args) {
  const { options } = flags(args, ["port", "run-dir", "slug", "no-browser-rendering"]);
  const port = Number(options.port ?? DEFAULT_PORT);
  const existing = runDirFromPointer();
  if (existing && fs.existsSync(path.join(existing, "run.json"))) {
    const run = readJson(path.join(existing, "run.json"));
    if (alive(run.pid) || markedProcesses(run.id).length) fail(`A verification run is already active at ${existing} (${run.origin}). Run \`verify.mjs cleanup\` first.`);
  }
  if (!fs.existsSync(path.join(REPO, "node_modules", ".bin", "vite"))) fail("node_modules is missing. Run `pnpm install --frozen-lockfile`.");
  const vars = devVars();
  if (!(await portFree(port))) fail(`Port ${port} is already in use. Choose another with --port; never drive a server this run did not start.`);

  const id = crypto.randomBytes(6).toString("hex");
  const runDir = path.resolve(options["run-dir"] ?? newRunDir(options.slug ?? "run"));
  const evidence = path.join(runDir, "evidence");
  const scratch = path.join(runDir, "scratch");
  if (fs.existsSync(scratch)) fail(`${scratch} already exists. Use a new --run-dir or run cleanup for that run.`);
  fs.mkdirSync(path.join(evidence, "logs"), { recursive: true });
  fs.mkdirSync(scratch, { recursive: true });

  // A production-free Worker config derived from the committed example: no routes, no APP_ORIGIN,
  // local D1 ID, absolute paths, and Clerk keys declared as secrets read from this process's env.
  const config = parseJsonc(fs.readFileSync(path.join(REPO, "wrangler.example.jsonc"), "utf8"));
  delete config.$schema;
  delete config.routes;
  delete config.route;
  config.main = path.join(REPO, config.main);
  for (const db of config.d1_databases ?? []) {
    db.database_id = "00000000-0000-0000-0000-000000000000";
    db.migrations_dir = path.join(REPO, db.migrations_dir ?? "migrations");
  }
  if (options["no-browser-rendering"]) delete config.browser;
  config.vars = { CLERK_MCP_CLIENT_ID: "", CLERK_MCP_CALLBACK_PORT: "", CLERK_API_KEYS_ENABLED: "" };
  config.secrets = { required: ["CLERK_PUBLISHABLE_KEY", "CLERK_SECRET_KEY"] };
  const configFile = path.join(scratch, "wrangler.verify.json");
  writeJson(configFile, config);
  writeJson(path.join(evidence, "wrangler.verify.json"), config);

  const childEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(APP_ORIGIN|CLERK_|CLOUDFLARE_|WRANGLER_|VITE_|NODE_OPTIONS$)/.test(key)));
  Object.assign(childEnv, {
    VERIFY_SHARPNER_RUN: id,
    VERIFY_SHARPNER_SCRATCH: scratch,
    CLERK_PUBLISHABLE_KEY: vars.CLERK_PUBLISHABLE_KEY,
    CLERK_SECRET_KEY: vars.CLERK_SECRET_KEY,
    CLERK_MCP_CLIENT_ID: vars.CLERK_MCP_CLIENT_ID ?? "",
    CLERK_MCP_CALLBACK_PORT: vars.CLERK_MCP_CALLBACK_PORT ?? "",
    CLERK_API_KEYS_ENABLED: vars.CLERK_API_KEYS_ENABLED ?? "",
    CI: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  });

  console.log(`Applying D1 migrations to ${path.join(scratch, "state")}`);
  const migrate = spawnSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "sharpner", "--local", "--config", configFile, "--persist-to", path.join(scratch, "state")],
    { cwd: REPO, env: childEnv, encoding: "utf8" });
  fs.writeFileSync(path.join(evidence, "logs", "migrate.log"), `${migrate.stdout}\n${migrate.stderr}`);
  if (migrate.status !== 0) fail(`D1 migrations failed. See ${path.join(evidence, "logs", "migrate.log")}.`);

  const devcap = has("devcap");
  const command = [...(devcap ? ["devcap"] : []), "pnpm", "exec", "vite", "--config", path.join(SKILL, "scripts", "vite.verify.config.mjs"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"];
  const log = fs.openSync(path.join(evidence, "logs", "server.log"), "a");
  const child = spawn(command[0], command.slice(1), { cwd: REPO, env: childEnv, detached: true, stdio: ["ignore", log, log] });
  child.unref();
  const origin = `http://127.0.0.1:${port}`;
  const run = {
    id, runDir, evidence, scratch, port, origin, pid: child.pid, pgid: child.pid,
    unit: devcap ? `devcap-${child.pid}.scope` : null, command: command.join(" "),
    session: `sharpner-verify-${id}`, browserRendering: !options["no-browser-rendering"],
    email: VERIFY_EMAIL, workspace: VERIFY_ORG, gitHead: gitHead(), startedAt: now(),
  };
  saveRun(run);
  writeJson(POINTER, { runDir });
  console.log(`Started ${run.command} (pid ${child.pid}); waiting for ${origin}`);

  const until = Date.now() + 180_000;
  let ready = false;
  while (Date.now() < until && !ready) {
    if (!alive(child.pid)) fail(`The server exited during startup. See ${path.join(evidence, "logs", "server.log")}, then run cleanup.`);
    try {
      const config = await (await fetch(`${origin}/auth/config`)).json();
      const html = await (await fetch(`${origin}/`)).text();
      const entry = await fetch(`${origin}/src/main.tsx`);
      ready = config.configured === true && html.includes('id="root"') && entry.ok;
    } catch { /* not listening yet */ }
    if (!ready) await sleep(1000);
  }
  if (!ready) fail(`The server did not become usable within 180s. See ${path.join(evidence, "logs", "server.log")}, then run cleanup.`);
  run.readyAt = now();
  saveRun(run);
  const report = await doctorChecks(run);
  printChecks(report);
  writeJson(path.join(evidence, `doctor-launch.json`), report);
  if (report.some((check) => check.status === "fail")) fail("Doctor failed right after launch. Do not drive this instance; run cleanup.");
  console.log(`\nReady: ${origin}\nRun dir: ${runDir}\nEvidence: ${evidence}\nNext: verify.mjs signin`);
}

async function doctorChecks(run) {
  const checks = [];
  const check = (name, status, detail) => checks.push({ name, status, detail });
  check("run", "pass", `${run.runDir} (started ${run.startedAt})`);
  check("process", alive(run.pid) ? "pass" : "fail", alive(run.pid) ? `pid ${run.pid} is running` : `pid ${run.pid} is not running; relaunch`);

  const listener = portListener(run.port);
  if (!listener) check("port-owner", "warn", "ss is unavailable; port ownership not checked");
  else if (!listener.listening) check("port-owner", "fail", `nothing listens on ${run.port}`);
  else {
    const ours = new Set(markedProcesses(run.id));
    const owned = listener.pids.length > 0 && listener.pids.every((pid) => ours.has(pid));
    check("port-owner", owned ? "pass" : "fail", owned ? `port ${run.port} belongs to this run (pid ${listener.pids.join(",")})` : `port ${run.port} belongs to another process (pid ${listener.pids.join(",") || "unknown"}); refuse to drive it`);
  }

  try {
    const response = await fetch(`${run.origin}/auth/config`);
    const config = await response.json();
    const problems = [];
    if (!config.configured) problems.push("Clerk is not configured");
    if (!/^pk_test_/.test(config.publishableKey ?? "")) problems.push("publishable key is not a development key");
    if ("appOrigin" in config) problems.push(`appOrigin is ${config.appOrigin}; the client would redirect away from ${run.origin}`);
    check("origin-guard", problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `/auth/config has no appOrigin, so the client stays on ${run.origin}; development Clerk key`);
    check("agent-config", config.mcpClientId ? "pass" : "warn", config.mcpClientId ? `public OAuth client published (callback port ${config.mcpCallbackPort})` : "no public OAuth client; mcp-login cannot run");
  } catch (error) {
    check("origin-guard", "fail", `GET /auth/config failed: ${error.message}`);
  }

  try {
    const metadata = await (await fetch(`${run.origin}/.well-known/oauth-protected-resource/mcp`)).json();
    const challenge = await fetch(`${run.origin}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    const ok = metadata.resource === `${run.origin}/mcp` && challenge.status === 401 && (challenge.headers.get("www-authenticate") ?? "").includes(run.origin);
    check("mcp-endpoint", ok ? "pass" : "fail", ok ? "MCP resource metadata and 401 challenge name this origin" : `resource=${metadata.resource}, unauthenticated status=${challenge.status}`);
  } catch (error) {
    check("mcp-endpoint", "fail", error.message);
  }

  const configFile = path.join(run.scratch, "wrangler.verify.json");
  if (fs.existsSync(configFile)) {
    const text = fs.readFileSync(configFile, "utf8");
    const config = JSON.parse(text);
    const problems = [];
    if (config.routes || config.route) problems.push("routes present");
    if (/"remote"\s*:/.test(text)) problems.push("a binding sets remote");
    if (/APP_ORIGIN/.test(text)) problems.push("APP_ORIGIN present");
    if ((config.d1_databases ?? []).some((db) => !/^0{8}-/.test(db.database_id))) problems.push("D1 ID is not the local placeholder");
    check("bindings-local", problems.length ? "fail" : "pass", problems.length ? problems.join("; ") : `generated config has no routes or remote bindings; state in ${path.join(run.scratch, "state")}; Browser Rendering ${config.browser ? "local" : "disabled"}`);
  } else check("bindings-local", "fail", `${configFile} is missing`);

  const head = gitHead();
  check("checkout", head === run.gitHead ? "pass" : "warn", head === run.gitHead ? `HEAD ${head?.slice(0, 12)}` : `HEAD moved from ${run.gitHead?.slice(0, 12)} to ${head?.slice(0, 12)} since launch; Vite reloads changed modules, but relaunch after migrations or config changes`);

  if (has("agent-browser")) {
    const sessions = spawnSync("agent-browser", ["session", "list"], { encoding: "utf8" }).stdout ?? "";
    if (!sessions.includes(run.session)) check("browser", "warn", "member browser not started; run signin");
    else {
      const url = redact(currentUrl(run));
      const local = url && (url.startsWith(run.origin) || /^https:\/\/[^/]+\.(clerk\.)?accounts\.dev\//.test(url) || url === "about:blank");
      let email = null, sockets = null;
      // A page that just opened may still be loading Clerk. Wait up to 5s before judging the session.
      try { email = evaluate(run, "(async () => { for (let i = 0; i < 50 && document.getElementById(\"root\") && !window.Clerk?.loaded; i++) await new Promise((r) => setTimeout(r, 100)); return window.Clerk?.user?.primaryEmailAddress?.emailAddress ?? null; })()"); } catch { /* not on the app */ }
      try { sockets = evaluate(run, SOCKETS_OK); } catch { /* not on a page */ }
      check("browser", local ? (email === run.email ? "pass" : "warn") : "fail",
        !local ? `member browser is on ${url}; it must stay on ${run.origin}` : email === run.email ? `member browser signed in as ${email} at ${url}` : `member browser at ${url} is not signed in as ${run.email}; run signin`);
      check("browser-sockets", sockets === true ? "pass" : "fail", sockets === true
        ? "WebSocket.OPEN is defined; the canvas can send edits and source requests"
        : "WebSocket.OPEN is undefined: the browser started without browser-init.js, so frames stay on \"Rendering…\". Run `verify.mjs ab close`, then signin");
    }
  } else check("browser", "warn", "agent-browser is not installed");

  const tokenFile = path.join(run.scratch, "mcp-token.json");
  if (fs.existsSync(tokenFile)) {
    const token = readJson(tokenFile);
    check("agent", token.expiresAt > Date.now() + 60_000 ? "pass" : "warn", token.expiresAt > Date.now() + 60_000 ? `agent connection valid until ${new Date(token.expiresAt).toISOString()}` : "agent connection expired; run mcp-login");
  } else check("agent", "warn", "no agent connection; run mcp-login before mcp");
  return checks;
}

function printChecks(checks) {
  for (const { name, status, detail } of checks) console.log(`${status.toUpperCase().padEnd(4)} ${name.padEnd(15)} ${detail}`);
}

async function doctor() {
  const run = loadRun();
  const checks = await doctorChecks(run);
  printChecks(checks);
  writeJson(path.join(run.evidence, `doctor-${Date.now()}.json`), checks);
  if (checks.some((check) => check.status === "fail")) { process.exitCode = 1; console.log("\nDoctor failed. Do not drive this instance. Fix the failure or run cleanup and relaunch."); }
}

function requireHealthy(run) {
  if (!alive(run.pid)) fail(`The server for run ${run.id} is not running. Run cleanup, then launch.`);
}

async function ensureClerkFixtures(run) {
  const created = [];
  let [user] = await clerk("GET", `/users?email_address=${encodeURIComponent(VERIFY_EMAIL)}`);
  if (!user) {
    user = await clerk("POST", "/users", {
      email_address: [VERIFY_EMAIL], first_name: "Sharpner", last_name: "Verify",
      skip_password_requirement: true, private_metadata: { sharpnerVerify: true },
    });
    created.push({ kind: "user", id: user.id, email: VERIFY_EMAIL });
  }
  const memberships = await clerk("GET", `/users/${user.id}/organization_memberships?limit=100`);
  let org = memberships.data.map((m) => m.organization).find((o) => o.name === VERIFY_ORG);
  if (!org) {
    org = await clerk("POST", "/organizations", { name: VERIFY_ORG, created_by: user.id, private_metadata: { sharpnerVerify: true } });
    created.push({ kind: "organization", id: org.id, name: VERIFY_ORG });
  }
  const record = { at: now(), userId: user.id, email: VERIFY_EMAIL, organizationId: org.id, organization: VERIFY_ORG, created };
  writeJson(path.join(run.evidence, "clerk-fixtures.json"), record);
  return record;
}

/**
 * Sign the page's Clerk instance in as the verification member with a one-time Backend API
 * sign-in token (strategy "ticket"). Works on the app and on Clerk's Account Portal pages.
 */
async function ticketSignIn(run, fixtures, organizationId) {
  await waitFor(run, "window.Clerk && window.Clerk.loaded", { label: "Clerk to load" });
  const { token } = await clerk("POST", "/sign_in_tokens", { user_id: fixtures.userId, expires_in_seconds: 300 });
  const org = JSON.stringify(organizationId);
  const result = evaluate(run, `(async () => {
    const clerk = window.Clerk;
    if (clerk.user && clerk.user.primaryEmailAddress?.emailAddress !== ${JSON.stringify(VERIFY_EMAIL)}) await clerk.signOut();
    if (!clerk.user) {
      const attempt = await clerk.client.signIn.create({ strategy: "ticket", ticket: ${JSON.stringify(token)} });
      if (attempt.status !== "complete") return { status: attempt.status };
      await clerk.setActive(${org} ? { session: attempt.createdSessionId, organization: ${org} } : { session: attempt.createdSessionId });
    } else if (${org} && clerk.organization?.id !== ${org}) {
      await clerk.setActive({ organization: ${org} });
    }
    return { status: "complete", email: clerk.user?.primaryEmailAddress?.emailAddress, organization: clerk.organization?.name ?? null };
  })()`);
  if (result?.status !== "complete") fail(`Clerk sign-in did not complete (status ${result?.status}).`);
  return result;
}

async function signin() {
  const run = loadRun();
  requireHealthy(run);
  const fixtures = await ensureClerkFixtures(run);
  console.log(`Clerk development instance: member ${fixtures.email} (${fixtures.userId}), workspace "${fixtures.organization}" (${fixtures.organizationId})${fixtures.created.length ? `; created ${fixtures.created.map((c) => c.kind).join(", ")}` : ""}`);
  ab(run, ["open", run.origin], { quiet: true });
  if (!evaluate(run, SOCKETS_OK)) {
    // The session was started elsewhere without the init script. Restart it so the script applies.
    ab(run, ["close"], { quiet: true });
    ab(run, ["open", run.origin], { quiet: true });
    if (!evaluate(run, SOCKETS_OK)) fail("WebSocket.OPEN is still undefined in the member browser. Check that agent-browser accepts --init-script.");
  }
  const result = await ticketSignIn(run, fixtures, fixtures.organizationId);
  ab(run, ["open", run.origin], { quiet: true });
  await waitFor(run, `document.querySelector("h1")?.textContent === "Files"`, { label: "the workspace file grid" });
  writeJson(path.join(run.evidence, "signin.json"), { at: now(), ...result, url: redact(currentUrl(run)) });
  console.log(`Signed in as ${result.email} in workspace "${result.organization}". The member browser shows the file grid at ${run.origin}/.`);
}

async function open(args) {
  const run = loadRun();
  requireHealthy(run);
  const { options, rest } = flags(args, ["viewer"]);
  if (!rest[0]) fail("Usage: verify.mjs open [--viewer] <path>");
  const url = requireLocalTarget(run, rest[0]);
  const result = ab(run, ["open", url], { viewer: options.viewer });
  process.exitCode = result.status ?? 1;
}

function passthrough(args, viewer) {
  const run = loadRun();
  requireHealthy(run);
  if (args[0] === "open" && args[1]) args = ["open", requireLocalTarget(run, args[1]), ...args.slice(2)];
  const result = spawnSync("agent-browser", [...browserArgs(run, viewer), ...args], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
}

function nextIndex(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return String(fs.readdirSync(dir).filter((name) => /^\d{2}-/.test(name)).map((name) => Number(name.slice(0, 2))).reduce((a, b) => Math.max(a, b), 0) + 1).padStart(2, "0");
}

async function capture(args) {
  const run = loadRun();
  const { options, rest } = flags(args, ["viewer"]);
  const [feature, label] = rest;
  if (!feature || !label) fail("Usage: verify.mjs capture [--viewer] <feature> <label>");
  const dir = path.join(run.evidence, feature);
  const base = path.join(dir, `${nextIndex(dir)}-${label.replace(/[^\w.-]+/g, "-")}${options.viewer ? "-viewer" : ""}`);
  const shot = ab(run, ["screenshot", `${base}.png`], { viewer: options.viewer, quiet: true });
  const snapshot = ab(run, ["snapshot"], { viewer: options.viewer, quiet: true });
  const url = redact(currentUrl(run, options.viewer));
  fs.writeFileSync(`${base}.aria.txt`, `URL: ${url}\nCaptured: ${now()}\n\n${redact(snapshot.stdout)}`);
  if (shot.status !== 0 || !fs.existsSync(`${base}.png`)) fail(`Screenshot failed: ${shot.stderr || shot.stdout}`);
  fs.appendFileSync(path.join(dir, "index.jsonl"), JSON.stringify({ at: now(), label, url, viewer: Boolean(options.viewer), screenshot: `${base}.png`, aria: `${base}.aria.txt` }) + "\n");
  console.log(`${base}.png\n${base}.aria.txt\nURL: ${url}`);
}

async function api(args) {
  const run = loadRun();
  requireHealthy(run);
  const [method, route, body] = args;
  if (!method || !route?.startsWith("/")) fail("Usage: verify.mjs api <METHOD> </path under /api> [json]");
  const token = evaluate(run, "window.Clerk?.session ? window.Clerk.session.getToken() : null");
  if (!token) fail("The member browser has no Clerk session. Run signin.");
  const response = await fetch(`${run.origin}/api${route}`, {
    method: method.toUpperCase(),
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body || undefined,
  });
  const text = await response.text();
  let data = text;
  try { data = JSON.parse(text); } catch { /* not JSON */ }
  const dir = path.join(run.evidence, "api");
  writeJson(path.join(dir, `${nextIndex(dir)}-${method.toLowerCase()}${route.replace(/[^\w]+/g, "-")}.json`), { at: now(), method: method.toUpperCase(), route: `/api${route}`, request: body ? JSON.parse(body) : null, status: response.status, response: data });
  console.log(JSON.stringify({ status: response.status, body: data }, null, 2));
  if (!response.ok) process.exitCode = 1;
}

async function mcpLogin() {
  const run = loadRun();
  requireHealthy(run);
  const vars = devVars();
  const config = await (await fetch(`${run.origin}/auth/config`)).json();
  const clientId = config.mcpClientId;
  const port = config.mcpCallbackPort;
  if (!clientId || !port) fail("No public OAuth client is configured (CLERK_MCP_CLIENT_ID and CLERK_MCP_CALLBACK_PORT in .dev.vars). See docs/agents.md.");
  const issuer = clerkIssuer(vars.CLERK_PUBLISHABLE_KEY);
  const discovery = await (await fetch(`${issuer}/.well-known/oauth-authorization-server`)).json();
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = crypto.randomBytes(16).toString("base64url");
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  let received = null;
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, redirectUri);
    if (url.pathname !== "/callback") { response.writeHead(404).end(); return; }
    received = Object.fromEntries(url.searchParams);
    response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>Agent connected</title><h1>Agent connected</h1><p>Return to the terminal.</p>");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); })
    .catch(() => fail(`Callback port ${port} is busy. Another agent sign-in may be running; retry when it finishes.`));
  try {
    const authorize = new URL(discovery.authorization_endpoint);
    Object.entries({ response_type: "code", client_id: clientId, redirect_uri: redirectUri, scope: "openid profile email", state, code_challenge: challenge, code_challenge_method: "S256" })
      .forEach(([key, value]) => authorize.searchParams.set(key, value));
    ab(run, ["open", authorize.href], { quiet: true });
    // Clerk's Account Portal (*.accounts.dev) keeps its own development-browser session, so the
    // member signs in there once, then approves the "Sharpner Claude Code wants to access" screen.
    const until = Date.now() + 120_000;
    let signedIn = false, consented = false;
    while (!received && Date.now() < until) {
      await sleep(1000);
      if (received) break;
      const url = new URL(currentUrl(run) ?? "about:blank");
      if (!/\.accounts\.dev$/.test(url.hostname)) continue;
      if (url.pathname.startsWith("/sign-in") && !signedIn) {
        await ticketSignIn(run, await ensureClerkFixtures(run), null);
        signedIn = true;
        const next = url.searchParams.get("redirect_url");
        if (next && /\.accounts\.dev$/.test(new URL(next).hostname)) ab(run, ["open", next], { quiet: true });
        console.log("Signed in on Clerk's Account Portal.");
      } else if (url.pathname.startsWith("/oauth-consent") && !consented) {
        const clicked = evaluate(run, `(() => {
          const allow = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Allow");
          if (!allow) return false;
          allow.click();
          return true;
        })()`);
        if (clicked) { consented = true; console.log('Approved Clerk consent ("Allow").'); }
      }
    }
    if (!received) {
      await capture(["mcp-login", "oauth-stuck"]).catch(() => {});
      fail(`OAuth approval did not reach ${redirectUri} within 120s. Last URL: ${redact(currentUrl(run))}. See evidence/mcp-login.`);
    }
    if (received.error) fail(`Clerk returned ${received.error}: ${received.error_description ?? ""}`);
    if (received.state !== state) fail("OAuth state mismatch; discard this attempt.");
    const response = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code: received.code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier }),
    });
    const token = await response.json();
    if (!response.ok || !token.access_token) fail(`Token exchange failed with ${response.status}: ${token.error ?? ""} ${token.error_description ?? ""}`);
    const expiresAt = Date.now() + (token.expires_in ?? 3600) * 1000;
    writeJson(path.join(run.scratch, "mcp-token.json"), { accessToken: token.access_token, refreshToken: token.refresh_token ?? null, expiresAt, scope: token.scope, clientId, revocation: discovery.revocation_endpoint }, 0o600);
    writeJson(path.join(run.evidence, "mcp-login.json"), { at: now(), clientId, redirectUri, scope: token.scope, tokenType: token.token_type, expiresAt: new Date(expiresAt).toISOString() });
    console.log(`Agent connected through Clerk OAuth as ${run.email}; the connection is valid until ${new Date(expiresAt).toISOString()}.`);
    ab(run, ["open", run.origin], { quiet: true });
  } finally {
    server.close();
  }
}

async function mcpCall(run, method, params) {
  const tokenFile = path.join(run.scratch, "mcp-token.json");
  if (!fs.existsSync(tokenFile)) fail("No agent connection. Run `verify.mjs mcp-login` first.");
  const { accessToken, expiresAt } = readJson(tokenFile);
  if (expiresAt < Date.now()) fail("The agent connection expired. Run `verify.mjs mcp-login` again.");
  const response = await fetch(`${run.origin}/mcp`, {
    method: "POST",
    headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: response.status, data };
}

async function mcp(args) {
  const run = loadRun();
  requireHealthy(run);
  const { options, rest } = flags(args, ["list"]);
  const dir = path.join(run.evidence, "mcp");
  const index = nextIndex(dir);
  if (options.list) {
    const { status, data } = await mcpCall(run, "tools/list", {});
    writeJson(path.join(dir, `${index}-tools-list.json`), { at: now(), status, response: data });
    if (status !== 200 || data.error) fail(`tools/list failed (${status}): ${JSON.stringify(data.error ?? data)}`);
    for (const tool of data.result.tools) console.log(`${tool.name.padEnd(20)} ${tool.description}`);
    return;
  }
  const [tool, json = "{}"] = rest;
  if (!tool) fail("Usage: verify.mjs mcp <tool> [json arguments] | mcp --list");
  let argumentsValue;
  try { argumentsValue = JSON.parse(json); } catch { fail("Tool arguments must be valid JSON."); }
  const { status, data } = await mcpCall(run, "tools/call", { name: tool, arguments: argumentsValue });
  const record = { at: now(), tool, arguments: argumentsValue, status, isError: data.result?.isError ?? Boolean(data.error), content: [] };
  for (const [i, item] of (data.result?.content ?? []).entries()) {
    if (item.type === "image") {
      const file = path.join(dir, `${index}-${tool}-${i}.${(item.mimeType ?? "image/png").split("/")[1]}`);
      fs.writeFileSync(file, Buffer.from(item.data, "base64"));
      record.content.push({ type: "image", file });
      console.log(`image: ${file}`);
    } else {
      let parsed = item.text;
      try { parsed = JSON.parse(item.text); } catch { /* plain text */ }
      record.content.push({ type: item.type, value: parsed });
      console.log(typeof parsed === "string" ? parsed : JSON.stringify(parsed, null, 1));
    }
  }
  if (data.error) record.error = data.error;
  writeJson(path.join(dir, `${index}-${tool}.json`), record);
  if (status !== 200 || record.isError) { console.error(`MCP ${tool} failed (${status}): ${JSON.stringify(data.error ?? data.result?.content ?? data)}`); process.exitCode = 1; }
}

function status() {
  const run = loadRun();
  console.log(JSON.stringify({ ...run, alive: alive(run.pid), processes: markedProcesses(run.id).length }, null, 2));
}

async function cleanup(args) {
  const { options } = flags(args, ["run-dir"]);
  const runDir = options["run-dir"] ? path.resolve(options["run-dir"]) : runDirFromPointer();
  if (!runDir) { console.log("No verification run is recorded for this checkout. Nothing to clean."); return; }
  const run = loadRun(runDir);
  const report = { at: now(), steps: [] };
  const step = (name, detail) => { report.steps.push({ name, detail }); console.log(`${name}: ${detail}`); };

  if (has("agent-browser")) {
    for (const session of [run.session, `${run.session}-viewer`]) {
      const result = spawnSync("agent-browser", ["--session", session, "close"], { encoding: "utf8" });
      step("browser", `${session}: ${(result.stdout || result.stderr).trim() || "closed"}`);
    }
  }

  const tokenFile = path.join(run.scratch, "mcp-token.json");
  if (fs.existsSync(tokenFile)) {
    const token = readJson(tokenFile);
    try {
      const response = await fetch(token.revocation, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: token.accessToken, client_id: token.clientId }) });
      step("agent-connection", `access token revocation returned ${response.status}`);
    } catch (error) { step("agent-connection", `access token revocation failed: ${error.message}`); }
  }

  if (alive(run.pgid)) {
    try { process.kill(-run.pgid, "SIGTERM"); step("server", `sent SIGTERM to process group ${run.pgid}`); } catch (error) { step("server", error.message); }
    for (let i = 0; i < 30 && alive(run.pgid); i++) await sleep(500);
  }
  if (run.unit && spawnSync("systemctl", ["--user", "is-active", "--quiet", run.unit]).status === 0) {
    spawnSync("systemctl", ["--user", "stop", run.unit]);
    step("scope", `stopped ${run.unit}`);
  }
  let left = markedProcesses(run.id);
  if (left.length) {
    for (const pid of left) { try { process.kill(pid, "SIGTERM"); } catch { /* gone */ } }
    await sleep(3000);
    left = markedProcesses(run.id);
    for (const pid of left) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    await sleep(500);
  }
  left = markedProcesses(run.id);
  step("processes", left.length ? `still running: ${left.join(", ")}` : "none left from this run");

  const scratch = path.resolve(run.scratch);
  if (path.basename(scratch) === "scratch" && path.dirname(scratch) === path.resolve(run.runDir) && fs.existsSync(scratch)) {
    fs.rmSync(scratch, { recursive: true, force: true });
    step("scratch", `removed ${scratch}`);
  }
  if (fs.existsSync(POINTER) && readJson(POINTER).runDir === run.runDir) fs.rmSync(POINTER);

  const free = await portFree(run.port);
  step("port", free ? `${run.port} is free` : `${run.port} is still in use`);
  const files = fs.existsSync(run.evidence) ? fs.readdirSync(run.evidence, { recursive: true }).length : 0;
  step("evidence", files ? `${files} entries kept in ${run.evidence}` : `missing: ${run.evidence}`);
  run.cleanedAt = now();
  saveRun(run);
  writeJson(path.join(run.evidence, "cleanup.json"), report);
  if (left.length || !free || !files) process.exitCode = 1;
}

// ---------- main ----------

const [command, ...args] = process.argv.slice(2);
const commands = {
  launch: () => launch(args), doctor, signin, open: () => open(args),
  ab: () => passthrough(args, false), viewer: () => passthrough(args, true),
  capture: () => capture(args), api: () => api(args), "mcp-login": mcpLogin, mcp: () => mcp(args),
  status, cleanup: () => cleanup(args),
};
if (!command || command === "help" || command === "--help" || !commands[command]) {
  console.log(HELP);
  process.exitCode = command && !["help", "--help"].includes(command) ? 2 : 0;
} else {
  try {
    await commands[command]();
  } catch (error) {
    if (!(error instanceof Failure)) throw error;
    console.error(`verify-sharpner: ${error.message}`);
    process.exitCode = 1;
  }
}
