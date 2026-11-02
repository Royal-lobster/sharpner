---
name: prove-it
description: Prove a Sharpner change works before you call it done. Maps each kind of change to the evidence it needs, from an interface test to a live drive of the real app or MCP endpoint. Use before you report a task as finished, open a pull request, or claim a bug is fixed.
---

# Prove it works

Check the real artifact, not a proxy. "It compiles", "the tests pass" and "the
code looks right" are not proof that a member or an agent sees the new behavior.
Adapted from pstack's prove-it-works principle and blast-radius evidence ladder.

## 1. State the finish condition

Write what "done" means as checks you can run. For example: "An agent's
`create_nodes` call adds a frame that appears on an open canvas without a reload;
the new test fails on main and passes here; typecheck and build pass."

## 2. Run the baseline checks

Run these for every code change:

```sh
pnpm test        # Vitest, Node environment, at most four workers
pnpm typecheck   # regenerates Worker types, then tsc
pnpm build
```

Run one test file while you iterate: `pnpm vitest run worker/room-layout.test.ts`.
Do not run the full suite at the same time as a browser-driving job.

## 3. Add the proof for the change type

| Change | Minimum proof |
| --- | --- |
| `shared/` layout, design system, specimens, thumbnails | A test at the module interface in the sibling `*.test.ts`. Layout changes also reflow surrounding sections; test that. |
| Worker route, auth, sharing, webhooks | A Hono `app.request(...)` test in `worker/*.test.ts`, including the rejected case (wrong workspace, missing origin, expired session, viewer). |
| MCP tool, schema or description | An `mcp.request` test like `worker/mcp-*.test.ts`. Keep `worker/mcp-discovery.test.ts` budgets green. Then call the tool against a local instance with the `verify-sharpner` skill. |
| FileRoom protocol, revisions, presence, comments | A `worker/room-*.test.ts` test. Then drive two live sessions with `verify-sharpner` and confirm both see the change. |
| Canvas or editor UI | Drive the changed flow in the running app with `verify-sharpner`. Check desktop and narrow mobile widths, keyboard navigation, focus restoration and reduced motion. Capture a screenshot and an ARIA snapshot; record a short video when motion or interaction matters. |
| Startup, rendering, thumbnails, cost | Follow the `vet-measurement` skill. A number without its checks is not evidence. |
| D1 migration | Apply it to a fresh local database and to an existing one with `pnpm db:migrate`. Read back the changed rows. |
| Skill or agent instruction text | Re-read it cold. Keep the terms in CONTEXT.md. For MCP text, run the discovery test and call `read_skill` locally. |
| Docs | Check each changed claim against the code. Mark historical experiment results as historical. |

A bug fix also needs a failing check first: a test or a live repro that fails on
the old code and passes on the new code. Keep both outputs.

## 4. Know how sure you are

For each fact your change depends on, reach the highest level that is cheap, and
say where you stopped:

1. You said so. Worthless alone.
2. You pointed at the `file:line`.
3. You walked the failure step by step and showed that it cannot happen.
4. You ran real code: a test or script that fails loudly if you are wrong.
5. You reproduced it in the running app or against the local MCP endpoint.

UI, realtime and MCP behavior need level 5. Pure functions in `shared/` can stop
at level 4.

## 5. Report

- List the commands you ran and their results. Paste failing-then-passing output
  for a bug fix.
- Name the evidence paths. Evidence stays outside the checkout; never commit
  screenshots or recordings.
- Say what you did not verify and why. "Inconclusive" and "verified on a
  different surface" are not passes.
