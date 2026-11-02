# Sharpner agent guide

Sharpner is a shared infinite canvas where people and coding agents design product UI.
It is one Cloudflare Worker (Hono) and a React 19 single-page app. Use the terms in
[CONTEXT.md](CONTEXT.md) for every name, message and doc. Read
[CONTRIBUTING.md](CONTRIBUTING.md) for conventions and
[docs/architecture.md](docs/architecture.md) for the full source map.

## Where things live

- `worker/index.ts`: HTTP routes. `worker/auth.ts`, `worker/accounts.ts`: Clerk sessions,
  OAuth and API keys, and the workspace membership projection in D1.
- `worker/room.ts`: the FileRoom Durable Object, one per file. It owns pages, nodes,
  comments, sockets and previews in its SQLite storage.
- `worker/mcp.ts`: MCP tools. `worker/skills/sharpner/`: the skill text agents read
  through `read_skill`.
- `worker/thumbnail-queue.ts`, `worker/thumbnail-policy.ts`, `worker/render.ts`: preview
  admission, its settings, and Browser Rendering.
- `src/Editor.tsx` (file chrome), `src/Canvas.tsx` (canvas), `src/room.ts` (realtime
  client), `src/canvas-render-plan.ts` (which frames render live).
- `shared/`: code the browser, the Worker and screenshots must agree on. Geometry goes in
  `shared/layout.ts` only. `shared/types.ts` builds frame documents.

## Set up a clone or worktree

```sh
pnpm install --frozen-lockfile
[ -f wrangler.jsonc ] || cp wrangler.example.jsonc wrangler.jsonc
```

Never copy `wrangler.jsonc` from another checkout. A deployer's copy holds production
routes, the production D1 ID and `APP_ORIGIN`. `.dev.vars` holds Clerk keys and is needed
only to run the app.

## Commands

```sh
pnpm vitest run worker/room-layout.test.ts   # one file while you iterate
pnpm test                                    # all tests, at most four workers
pnpm typecheck                               # needs wrangler.jsonc
pnpm build
```

CI runs `test`, `typecheck` and `build`. There is no linter or formatter; match the
surrounding code. Do not run the full suite while a browser-driving job runs.

To see a change in the real app, use the `verify-sharpner` skill. It launches an isolated
instance with no production origin or remote bindings, signs in a verification member,
and connects an agent over MCP. `pnpm dev` reads your local `wrangler.jsonc` as it is.

## Production needs an explicit request

Run these only when the person you work for asked for that action in this session:
`pnpm deploy`, `pnpm run deploy`, `wrangler deploy`, `wrangler rollback`,
`wrangler versions deploy`, `wrangler secret ...`, and any command with `--remote`.
Remote D1 migrations cannot be undone. In Claude Code, a hook in `.claude/settings.json`
blocks these commands and explains how to confirm one.

## Prove the change

Follow the `prove-it` skill before you report work as done. In short:

| Change | Proof |
| --- | --- |
| `shared/` logic | A test at the module interface in the sibling `*.test.ts`. |
| Worker routes, auth, sharing | An `app.request` test, including the rejected case. |
| MCP tools or text | A `worker/mcp-*.test.ts` test, then a local call through `verify-sharpner`. |
| FileRoom protocol | A `worker/room-*.test.ts` test, then two live sessions through `verify-sharpner`. |
| Canvas or editor UI | Drive it with `verify-sharpner` at desktop and narrow widths. |
| Startup, rendering, cost | Vet every number with the `vet-measurement` skill. |

Report what you did not verify. A passing unit test does not prove a UI change.

## Invariants that are easy to break

- FileRoom `MIGRATIONS` in `worker/room.ts` are append only. Never edit or reorder one.
- A change to rendered output (frame documents, specimens, compiled CSS) needs a new
  FileRoom migration that bumps `rev` for the affected nodes and sets `thumbReconcile`,
  so existing previews render again. Guard a one-time migration with a `meta` key.
- Keep revision checks, source-cache budgets, request backpressure and the
  first-camera-fit guard when you change the realtime client or the renderer.
- Scope every operation to a current workspace member. Browser sessions and agent
  credentials keep separate entry points. Mutating MCP tools go through `access().apply`.
- Screens render their authored HTML; Sharpner never applies a theme to a screen.
  Specimens render in dark when the tokens declare a `dark` theme.
- `worker/mcp-discovery.test.ts` enforces the MCP text budgets and checks that every
  reference linked from the skill is served. Keep it green.
- Never commit screenshots, recordings or other verification media.

## Docs

- Current behavior: README.md, CONTRIBUTING.md, CONTEXT.md, SECURITY.md,
  docs/architecture.md, docs/agents.md, docs/interaction-playback.md, docs/adr/, and
  worker/skills/sharpner/.
- Historical experiment logs: docs/live-canvas-rendering.md,
  docs/unseen-overview-convergence.md, docs/instant-variant-documents.md and
  docs/interaction-first-experiments.md. docs/thumbnail-rendering.md mixes current
  admission rules with historical measurements. Check the code before you act on them.
- When you remove or rename behavior, search docs/, CONTEXT.md, worker/skills/ and the
  descriptions in worker/mcp.ts for its terms, and update them in the same change.
- Agent-facing text follows "Agent instruction text" in CONTRIBUTING.md.

## Skills

Project skills live in `.agents/skills/`. Claude Code loads them through the symlinks in
`.claude/skills/`.

- `verify-sharpner`: launch, sign in, drive the app and MCP, capture evidence, clean up.
- `maintain-verify-sharpner`: keep the verification skill and its feature map current.
- `prove-it`: the evidence each change type needs.
- `vet-measurement`: checks for a performance or cost number.

## Pull requests

Explain the trigger, the resulting behavior and the verification you reached. Attach
evidence to the pull request from outside the checkout.
