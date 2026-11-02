---
name: vet-measurement
description: Vet a Sharpner performance or cost number before you report it, act on it, or write it into docs or a PR. Use when you measure startup, canvas pan or input latency, preview or thumbnail time, Browser Rendering time, bundle size, Durable Object or D1 work, or a Cloudflare cost estimate.
---

# Vet a measurement

A number is evidence only after it survives these checks. Answer each check with
output from a run, not with a reading of the code. Adapted from pstack's
benchmark checklist.

A quick ballpark that the member asked for needs one run. Still answer checks 4
and 7, and say that it is one run. A choice between options is never a ballpark.

## Before you run

1. Write the claim as you would ship it. For example: "Direct file open reaches a
   revealed canvas preview 30% sooner at the median on the forty-frame fixture."
   The checks test that sentence.
2. Read the measurement code. Note what it times, what it counts, and what it ignores.
3. Run `uptime` and `nproc`. Other agents can share this machine. If the load is
   high, find the cause. If you cannot stop it, alternate the sides so both see
   the same noise, and say so in the report.
4. Do not measure while a full test suite or another browser-driving job runs.

## Sharpner conditions to control

- **Build.** Measure a production build. `pnpm build` then `pnpm preview` serves
  the built app and Worker. `pnpm dev` adds Vite transforms and HMR; never compare
  a dev side with a production side.
- **Cache state.** Name it for each side: sources, fonts, HTTP cache, the
  thumbnail cache (`src/thumbnail-cache.ts`), preview batches, and compiled CSS.
  Cold, prepared and warm are different results. Report them separately.
- **Production cache headers.** `public/_headers` sets immutable caching for
  `/assets/*`. Local servers can differ. Check the response headers you measured.
- **Auth.** Simulated auth and local responses omit real Clerk initialization and
  socket readiness. Measure real sign-in and authenticated socket readiness
  separately, as CONTRIBUTING.md requires for startup work.
- **End state.** A startup measurement ends at a visible, fully revealed canvas
  preview or file grid. A metadata response or an error page is not an end state.
- **Device.** This desktop is not a phone. A resized desktop window is not mobile
  performance. State the browser, its version, the viewport, and the machine.
- **Server cost.** Local wall-clock time is not Worker CPU time. Browser Rendering
  time is launch-through-close wall time. Price estimates cite the Cloudflare
  pricing page and the date you read it.

## The checks

1. **Why not double?** Name the limiter. Profile in a run you do not report,
   because profilers slow the work. Use the Chrome performance panel or a trace,
   `node --cpu-prof`, or CPU per process. Map the hot spot to source. If a change
   did not move the number, the limiter explains why.
2. **Was each side tuned?** Run every side as production runs it: production
   build, production flags, the same data, the same cache state. If one side used
   defaults, you compared configurations, not implementations.
3. **Did it break a limit?** Do the arithmetic. Removing a piece that takes 10% of
   the run can make the run at most about 11% faster. A result past a physical
   limit measured a cache, a no-op, or a bug.
4. **Did it error?** Count failures, non-200 responses, socket reconnects, blank
   frames and placeholder previews. Check that the output is correct, not only
   present. Rejections are fast.
5. **Does it reproduce?** Run each side at least five times, alternating A, B, A,
   B. Report the median and the range. A gap smaller than the run-to-run range is
   no measurable difference.
6. **Does it matter?** Measure the end-to-end path a member waits on, at
   realistic sizes: frame count, section nesting, comment count, concurrent
   members. Report a micro result as its share of that path.
7. **Did the work happen?** Confirm that the work ran inside the timed region:
   the request reached the Worker, the Durable Object answered, the preview was
   decoded and painted, the thumbnail was written. Lazy work and timeouts produce
   numbers for work that never happened.

## Report

- Lead with the verdict: faster, slower, no measurable difference, or inconclusive.
- Give the number with its unit, the run count, the range, the cache state and the
  limiter. For example: "p50 2.12 s to 1.48 s, median of 7 alternating runs per
  side, range 1.41 to 1.55 s after, prepared editor, bound by preview decode."
- Call it inconclusive when you cannot name the limiter, a side ran untuned, or
  checks 4 and 7 could not run. Name the gap.
- State the conditions the way the docs in `docs/` do: date, build, browser,
  viewport, machine, fixture, and what the result is not (for example, "a
  feasibility measurement, not a production SLO").
- Put one primary number in a PR body. Keep runs, ranges and traces in the run's
  artifact directory, outside the checkout. Record durable results in the topic's
  doc under a dated experiments heading.
