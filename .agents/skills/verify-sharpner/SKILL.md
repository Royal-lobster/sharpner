---
name: verify-sharpner
description: Launch an isolated, production-free local Sharpner, sign a browser in as a verification member, connect an agent through MCP, drive the canvas the way a member and an agent do, and capture evidence. Covers the browser surface (workspace home, file canvas, comments, share link viewer) and the MCP surface (/mcp tools). Use to prove a canvas, editor, FileRoom or MCP change works in the real app, or to reproduce a bug a member or agent reported.
---

# Verify Sharpner

`scripts/verify.mjs` runs one local Sharpner per checkout. It keeps all state in a
per-run directory, signs in through the Clerk development instance, and never
touches sharpner.app or remote Cloudflare bindings. Run every command from the
repository root. In this file, `V` means:

```sh
V=".agents/skills/verify-sharpner/scripts/verify.mjs"
```

The feature map in [features/README.md](features/README.md) has one recipe per
user-facing feature. Read it before you drive a feature.

## Prerequisites

- Node.js 24 or newer, pnpm, and `pnpm install --frozen-lockfile`.
- agent-browser 0.38 or newer: `npm i -g agent-browser && agent-browser install`.
- `.dev.vars` with development Clerk keys (`pk_test_`, `sk_test_`). `launch`
  refuses live keys. `mcp-login` also needs `CLERK_MCP_CLIENT_ID` and
  `CLERK_MCP_CALLBACK_PORT` (see [docs/agents.md](../../../docs/agents.md)).
  The script reads `.dev.vars` at runtime. Never print or copy its values.
- Optional: `devcap` on PATH. When it is present, `launch` runs the server under
  it to cap memory. Without `agent-artifacts`, evidence goes to
  `${XDG_CACHE_HOME:-~/.cache}/agent-artifacts/sharpner/<date>/`.
- One run per checkout. Two checkouts can run at once with different `--port`
  values. `mcp-login` uses one fixed callback port, so run one `mcp-login` at a
  time on the machine.

## Launch

```sh
node $V launch --run-dir "$(agent-artifacts new sharpner verify-<task>)"
```

Omit `--run-dir` to let the script create the artifact directory itself.
`launch` does these steps:

1. Writes a Wrangler config without routes, `APP_ORIGIN` or remote bindings.
2. Applies D1 migrations to an empty `scratch/state` directory.
3. Starts Vite on `http://127.0.0.1:5199` under devcap.
4. Waits until `/auth/config` reports Clerk configured and the SPA entry loads.
5. Runs Doctor.

The ready signal is the line `Ready: http://127.0.0.1:5199`, after a Doctor
table with no `FAIL`. Launch exits 1 on any failure. Run `cleanup` after a failed
launch. Local Browser Rendering is on. Add `--no-browser-rendering` to turn it off;
thumbnails and `screenshot_nodes` then stop working.

## Doctor

```sh
node $V doctor
```

Run Doctor first whenever anything looks wrong, and after every failed drive.
It is read-only and exits 1 when the instance is unsafe or broken. Never drive an
instance with a `FAIL` row.

| Check | Passes when |
| --- | --- |
| `process`, `port-owner` | The server runs, and this run's processes own the port. |
| `origin-guard` | `/auth/config` has no `appOrigin` and uses a `pk_test_` key. |
| `bindings-local` | The generated config has no routes, no remote bindings, a placeholder D1 ID. |
| `mcp-endpoint` | `/mcp` metadata and its 401 challenge name the local origin. |
| `browser` | The member browser stays on the local origin or Clerk's development pages. |
| `browser-sockets` | `WebSocket.OPEN` is 1 in the member browser (see Failure triage). |
| `agent` | The agent connection is valid. A warning before `mcp-login` is normal. |

## Sign in

```sh
node $V signin
```

This finds or creates the verification member and workspace in the Clerk
development instance, then signs the member browser in with a one-time sign-in
ticket. It ends with `Signed in as sharpner-verify+clerk_test@example.com in
workspace "Sharpner Verify"`, with the file grid open at `/`.

## Connect an agent (MCP)

```sh
node $V mcp-login
node $V mcp --list
node $V mcp get_app_state
```

`mcp-login` runs the real Clerk OAuth flow with PKCE. The member browser signs in
on Clerk's Account Portal and selects `Allow` on the consent screen. Success prints
`Agent connected through Clerk OAuth`. Then call any tool:

```sh
node $V mcp create_file '{"workspaceId":"<id from get_app_state>","name":"Verify MCP loop"}'
```

`mcp` prints the tool result and exits 1 when the tool reports an error. Run
`mcp read_skill '{}'` when you need the agent workflow rules.

## Drive

Drive the member browser with `node $V ab <agent-browser args>`. Drive a separate,
signed-out browser with `node $V viewer <agent-browser args>`. Both sessions use
the domain allowlist and `scripts/browser-init.js`. `open` refuses any origin
other than the run's own.

```sh
node $V open /f/<fileId>
node $V ab find role button click --name "Share file"
node $V ab wait --fn 'document.querySelectorAll("[data-frame] iframe").length > 0'
node $V ab snapshot
```

Use stable handles, never coordinates or tab order:

- Routes: `/` (workspace home), `/f/<fileId>?page=<pageId>&node=<nodeId>` (file
  canvas), `/s/<shareToken>` (share link viewer).
- ARIA names from `src/`: navigation `File and pages` and `Collaboration`,
  toolbar `Zoom`, buttons `Share file`, `Comments, <n> open`, `Add a comment`,
  `Zoom to fit`, `File menu for <file name>`.
- Canvas data: `.canvas[data-ready]` after the first camera fit,
  `[data-frame="<nodeId>"]` for each frame, `.frame-label`, and
  `[data-frame] iframe[title="<nodeId>"]` for a live frame.
- `ab wait --fn` takes an expression that returns a boolean. An expression that
  returns an element does not work.

## Evidence

Every run writes evidence to `<run dir>/evidence/`, outside the checkout. Never
put evidence in the repository.

| Path | Written by |
| --- | --- |
| `<feature>/NN-<label>.png`, `.aria.txt`, `index.jsonl` | `node $V capture <feature> <label>` (add `--viewer` for the viewer) |
| `mcp/NN-<tool>.json` | every `mcp` call: arguments, status and response body |
| `api/NN-<method>-<path>.json` | every `api` call |
| `logs/server.log`, `logs/migrate.log` | `launch` |
| `doctor-*.json`, `signin.json`, `mcp-login.json`, `clerk-fixtures.json`, `cleanup.json` | the matching command |

Proof standards:

- Drive the real user path: buttons, keyboard and MCP tools. Do not call internal
  setters or test-only endpoints to make a state.
- Capture the action and the result. Take a capture before and after a change.
- Check side effects from a second view. For example, read back a comment with
  `mcp list_comments` after you post it in the browser.
- Report each feature as verified, verified-unreachable (name the missing
  prerequisite and the command you tried) or unproven.
- Capture URLs and ARIA text redact Clerk one-time values. Check a capture before
  you share it.

## Cleanup

```sh
node $V cleanup
```

Cleanup closes both browser sessions and revokes the agent connection's access
token. It stops the server's process group and devcap scope, then kills any
process marked with this run's ID. It deletes `scratch/` (local D1, R2, Durable
Objects, Vite cache) and the checkout's run pointer. It keeps `evidence/` and
`run.json`, prints the evidence path, and exits 1 if a process or the port
remains. Use `cleanup --run-dir <dir>` for a run that is not current. Run cleanup
after every failed attempt, then confirm:

```sh
ss -ltnp 'sport = :5199'                                         # no listener
systemctl --user list-units --type=scope | grep vite.verify      # no output
```

## Failure triage

| Symptom | Cause | Action |
| --- | --- | --- |
| `Port 5199 is already in use` | Another server owns the port. | Use `--port`. Never drive a server this run did not start. |
| `A verification run is already active` | An earlier run was not cleaned up. | `node $V cleanup`, then launch again. |
| `D1 migrations failed` or `did not become usable within 180s` | Migration or Vite startup error. | Read `evidence/logs/`, run cleanup, fix, relaunch. |
| Doctor `origin-guard` fails | `APP_ORIGIN` reached the Worker. | Stop. Run cleanup. Find the variable in your environment. |
| Doctor `browser-sockets` fails, or frames show `Rendering…` with no iframe | The browser started without `browser-init.js`. agent-browser's allowlist wrapper then drops `WebSocket.OPEN`, so the canvas never sends. | `node $V ab close`, then `node $V signin`. |
| A frame shows `Rendering…` and `browser-sockets` passes | The frame is outside the live set: too small on screen, or more than 12 visible frames have no thumbnail. | Select `Zoom to fit` or zoom in. Look for `thumbnail-turn` in `logs/server.log`. |
| `Callback port <n> is busy` | Another `mcp-login` is running. | Wait for it, then retry. |
| `OAuth approval did not reach` | Clerk consent stalled. | Read `evidence/mcp-login/*-oauth-stuck.png`, then retry `mcp-login`. |
| `No agent connection`, `expired`, or `mcp` returns 401 | No connection, or cleanup revoked it. | `node $V mcp-login`. |
| A request to a new host fails in the browser | The domain allowlist blocks it. | Add the host to `ALLOWED_DOMAINS` in `verify.mjs` only if it is read-only and not production. |

## Helpers

- `scripts/verify.mjs`: the control CLI. `node $V help` lists every command.
  `status` prints the current run. `api <METHOD> <path> [json]` calls `/api` as the
  member.
- `scripts/vite.verify.config.mjs`: wraps `vite.config.ts` with the generated
  Wrangler config and per-run state. `launch` uses it. Do not run it by hand.
- `scripts/browser-init.js`: restores `WebSocket.OPEN` and the other constants that
  agent-browser's allowlist wrapper removes. Every `ab` and `viewer` call passes it.

## External state

All app data is local and disappears at cleanup. The only state outside the
machine is in the Clerk development instance named by `.dev.vars`:

- Member `sharpner-verify+clerk_test@example.com`, first name `Sharpner`, last name
  `Verify`, `private_metadata.sharpnerVerify: true`. The `+clerk_test` address is a
  Clerk test address, so Clerk sends no email.
- Workspace `Sharpner Verify`, a Clerk organization the member owns, with
  `private_metadata.sharpnerVerify: true`.
- Each run adds Clerk sessions, a sign-in ticket and an OAuth consent for this
  member. Cleanup revokes the OAuth access token.

`signin` reuses both fixtures and records their IDs in
`evidence/clerk-fixtures.json`. Remove them only when someone asks: delete the
organization, then the member, in the Clerk Dashboard for the development
instance.

## Keep the map current

Use `.agents/skills/maintain-verify-sharpner` to audit this skill and its feature
map after changes to UI, routes or MCP tools.
