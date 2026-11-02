---
name: maintain-verify-sharpner
description: Periodic pass that keeps the verify-sharpner skill and its feature map true to the app. One read-only source reader per feature, one live run that drives every feature, and at most one pull request of proven corrections. Use when asked to audit or maintain the verification skill, or after changes that rename UI, routes or MCP tools.
disable-model-invocation: true
---

# Maintain verify-sharpner

A feature map goes stale as soon as the app changes. This pass keeps
`.agents/skills/verify-sharpner/` honest. The unit of rigor is the feature: read
every feature file against the source, and drive every feature live. Adapted from
pstack's maintain-verification-skill.

## Outcomes

End with exactly one outcome, and say which:

- **clean**: every feature has source and live coverage, and nothing needs a change.
  No branch, no pull request.
- **changed**: one pull request ships proven corrections to the skill.
- **blocked**: coverage could not finish, or a proven fix could not ship safely.
  Name the blocker.

## Edit scope

Edit only `.agents/skills/verify-sharpner/`: its SKILL.md, `features/` and
`scripts/`. Never edit product code in this pass. When the app no longer does what
the map says, decide which it is:

- **Doc drift**: the app changed on purpose. Fix the map.
- **Product regression**: the app broke. Report it to the person you work for.
  Do not hide it with a doc edit.

## Pass

1. **Find the baseline.** Run
   `git log -1 --format='%h %cs' -- .agents/skills/verify-sharpner` to get the last
   change to the skill. Every later change to `src/`, `worker/mcp.ts`,
   `worker/index.ts` and `worker/skills/` is in scope for drift.
2. **Check the index.** Read `features/README.md` and list `features/*.md`. Fix
   missing, extra, duplicate and dead entries.
3. **Read the source, one feature at a time.** Start one read-only subagent per
   feature file, all at once. Each one explains how the feature works now, from
   `src/` and `worker/`. It flags drift with `file:line` citations: changed ARIA
   labels, button text, routes, MCP tool names or parameters. It returns one
   short live recipe. Subagents never drive the app and never edit files.
4. **Reconcile.** Confirm that every feature file has a summary. Spot-check cited
   drift; do not re-prove clean claims. Look through the changes since the
   baseline for user-facing surfaces the map lacks: new routes in
   `src/router.tsx`, new menu items in `src/Editor.tsx`, new tools in
   `worker/mcp.ts`. Name a concrete source path before you call one missing.
   Merge the recipes into as few app states as you can.
5. **Drive every feature live.** You own all driving. Follow the verify-sharpner
   SKILL.md: `launch`, `doctor`, `signin`, `mcp-login`, then each feature's
   recipe through `verify.mjs`. Keep three rules for the whole pass:
   - Run `doctor` before the first drive and again after any failed or surprising
     drive. If the instance looks healthy but the page is wedged, reload or
     relaunch; do not keep driving it.
   - Keep every capture. Check that evidence still exists at its path after each
     cleanup.
   - Clean up what a failed attempt started before you try again.
   A feature is `verified-unreachable` only when you name the missing
   prerequisite and the route you tried. If the map omits that prerequisite,
   that is drift. Drive every harness fix live again before it ships. Run
   `cleanup` after the last drive, including re-proofs.
6. **Triage.** A wrong or missing description is doc drift: fix it. Working
   behavior that the harness cannot drive is a harness gap: fix `verify.mjs`,
   keep it executable, and show the new invocation in SKILL.md. Broken app
   behavior is a product gap: record it for the person you work for and keep it
   out of this pull request.
7. **Ship or stop.** For **changed**, re-read every changed file, then open one
   pull request of proven corrections with the evidence paths in its body. For
   **clean** or **blocked**, open nothing and report the outcome and coverage.

Keep short run notes (features covered, unreachable prerequisites, confirmed
drift, outcome) in the run's artifact directory. Do not commit them.
