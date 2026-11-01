# Motion and interaction as part of every screen

## Decision

Treat frames and components as capable of behavior. A screen's source and theme
define the design; it may also declare example data or named scenarios. The viewer's
execution mode decides whether it shows a poster, plays motion, or receives input. Keep one input
owner. Start with one active runtime, and consider a small additional motion
allowance only when measured work and device conditions permit it. Four active
dense fixtures worked on this desktop; this is not justification for a universal
four-screen default or for running an entire overview.

The current `interactive` flag in [playback](interaction-playback.md) remains a
compatibility/rollout gate. It should not define a separate permanent screen kind.
Automatic motion should eventually be able to play on a focused screen without
entering input mode. Input mode remains useful for choosing whether gestures edit
the canvas or operate the design.

These experiments are preserved on
[`experiment/interaction-first-performance`](https://github.com/Royal-lobster/sharpner/tree/experiment/interaction-first-performance).
The prototype files and endpoint stay on that branch. No executable prototype,
new binding or schema change is part of this decision report.

## Fixture and method

Local production build, Chrome 156 on the 64 GB Forge desktop, 1280×800 browser
viewport. The prototype replaces the canvas surface inside the existing signed-in
file route; editor chrome, authentication and Room startup remain. Source, state
and posters are synthetic and viewer-local. No source/metadata writes or uploads
are performed. Recording and screenshots were disabled during timing runs.

One 1000×760 trading screen contains an order book, changing prices/chart, native
WAAPI motion, trade/deposit input, pending/partial/success/failure states, named
scenarios, pause/reset/seek and serializable local state. The normal shared
`frameDocument` renders it. Tailwind 4.3.3 is compiled once outside the browser;
CSS is about 5.2 KB. Fonts use the system fallback with no external requests. The
dense version has 120 rows, 561 descendant elements and about 27.9 KB of source.
Its clipped rows deliberately continue updating to stress authored work.

The surrounding 300 images are schematic SVG posters, repeated from one URL per
theme. They isolate execution scheduling and do not measure real thumbnail decode,
network loading, capture fidelity or a 300-distinct-design workload. The prototype
transforms its surface during pan probes; this is not the production camera's
complete gesture/selection pipeline or a GPU FPS measurement.

Two equivalent market simulations were compared: a requestAnimationFrame callback
that updates data only at 10 Hz, and an owned timer near each 100 ms data boundary
plus exact product-state deadlines. Native animations play independently. A third,
native-only control runs the two simple motion loops without automatic market or
product-state updates; it is a lighter workload, not an equivalent renderer.

Each matrix configuration has three roughly three-second pan samples and twenty
input commands paced at 100 ms. Commands go through the opaque iframe's scoped
postMessage bridge and acknowledge after a rendering opportunity. These are command
round-trip timings, not physical input-to-photon or INP measurements. Under heavy
load, some original input loops outlasted the pan window. Final four/forty checks
stop issuing input at the sample deadline and reproduce the conclusion.

Setup timings exclude authentication and the CSS request, then include poster
creation and readiness of all admitted documents. Theme timings include image
URL updates, child commands and two parent animation-frame waits. This fixed
measurement allowance contributes tens of milliseconds. Compilation took 21 ms
cold and 0–1 ms warm in these samples; the authenticated local preparation request
also incurs separate session/network latency. None of these numbers is a cold-file
opening SLO.

## Measurements

With forty surrounding posters and one 24-row live screen, six theme changes
took **127–138 ms** when recreating its document (median 133 ms), versus
**49–50 ms** in the persistent document (median 49 ms). The reload control resets
local input, matching the conservative production behavior; the cooperative
persistent fixture retains it. Four persistent screens took 41–48 ms in that run.

The dense matrix below uses 300 surrounding posters. Input p95 combines sixty
commands; pan p95 is the range across the three samples. Setup is a single sample.

| Live dense screens | Mode | All admitted ready | Theme median | Pan frame interval p95 | Input-command p95 | Long-task time / sample |
| ---: | --- | ---: | ---: | ---: | ---: | ---: |
| 0 | Posters only | 57 ms | 33 ms | 16.7–16.8 ms | — | 0 |
| 1 | Scheduled data | 154 ms | 46 ms | 16.7–16.8 ms | 18.9 ms | 0 |
| 4 | rAF + 10 Hz data | 174 ms | 48 ms | 16.7–16.8 ms | 33.7 ms | 0 |
| 4 | Scheduled data | 180 ms | 45 ms | 16.7–16.8 ms | 22.8 ms | 0 |
| 12 | Scheduled data | 253 ms | 72 ms | 16.8 ms | 46.2 ms | 0 |
| 40 | Scheduled data | 583 ms | 356 ms | 83–100 ms | 218 ms | 1.53–1.88 s |
| 40 | Native motion only | 609 ms | 104 ms | 33.4 ms | 61.5 ms | 0 |

Four rAF-driven simulations made 724 callbacks per three-second sample. Scheduled
simulations made 120, an **83% reduction**, for the same 120–124 market updates.
Average instrumented synchronous authored render work was 46.9 versus 44.4 ms per
sample: a modest reduction, not an 83% CPU saving. Work timing excludes browser
style/layout, paint/compositing, dispatch overhead and other code. Forty scheduled
screens fell behind the intended update rate and produced substantial main-thread
long tasks. Even the lighter forty-screen native control missed frames.

A separate **30-second** pan probe with four dense scheduled screens recorded
1,800 frame intervals, **16.7 ms p95**, 16.8 ms maximum and **zero long tasks**.
It performed 1,200 scheduled updates with 370 ms of instrumented authored render
work. That excludes browser rendering costs and does not establish battery use or
memory per screen.

The final build recheck kept four dense screens at 16.7–16.8 ms pan p95, with
input commands at most 26.2 ms. Forty again reached 83–100 ms pan p95 and up to
214 ms input-command latency. The exact ordering and cache history were not
randomized; these are feasibility measurements with a negative control, not a
controlled hardware benchmark or a low-end/mobile claim.

## Correctness and lifecycle checks

- Trade and deposit scenarios run automatically and through real browser input.
  Typing 725.50, placing an order, switching Light/Dark mid-action and reaching
  Filled retained the input and action. A 1500.75 deposit reached Confirmed.
- rAF, scheduled and native modes reproduced the same seeded market/state checksum
  after seeking away and back to the same scenario/time. This checks modeled data,
  phase and input; it is not a pixel identity assertion for every transient effect.
- A paused deposit at 900 ms, amount 1500.75, was exported, disposed, recreated and
  restored with the same checksum and exact logical time. There is no wall-clock
  catch-up while evicted. Production checkpoints still need content/schema identity
  checks and byte/count limits; this fixture validates only its own version 1 state.
- Paused instances had zero running animations, no pending timer/rAF and unchanged
  callback/update/DOM-write counts after 1.2 seconds. A synthetic parent-tab hidden
  event also stopped all work; a physical backgrounded-device lifecycle was not
  tested.
- Twenty focus requests spaced 10 ms apart coalesced into one new document after
  an 80 ms quiet period; peak residency stayed four. Twenty theme requests likewise
  coalesced to one application, with no new documents and the final theme correct.
  These call the prototype scheduler methods; manual toolbar controls bypass the
  debounce. This does not establish general concurrent scheduler correctness.
- Light/Dark were captured with editor chrome at 1280×800 and 390×844. The latter
  is a resized desktop browser showing a fixed-width design, not phone performance.
  The recorded input demo uses eight order-book rows; performance runs use 24/120.

A deliberate structural-component test caught the limit of variable-only theme
updates: the root switched to Dark while the Light component markup remained.
Recreating through `frameDocument` and restoring the local state produced the
correct Dark markup and retained the deposit/input checksum in **150 ms**. This
fallback is required for structural overrides, and cold fonts/assets need their
own readiness handling. Root-variable success does not prove all theme variants.

## Cost and production path

Local play, theme commands, animation ticks, scenario changes and seeking call no
server browser and upload no previews: **0 additional Browser Run seconds and
0 R2 writes** per operation. The prototype's CSS preparation consumes Worker CPU;
normal editor session/presence requests remain. Existing poster generation,
covers and explicit agent screenshots retain the cost and policy in
[thumbnail rendering](thumbnail-rendering.md). No further per-workspace monthly
server saving is claimed by this experiment. Creating a poster for every possible
scenario/time would increase cost and is not the proposed policy.

Implement the next production stage through the existing render planner and
document renderer:

1. Give authored screens an optional small lifecycle contract for scenarios,
   local state, play/pause/reset/seek and presentation-safe theme changes. Simple
   CSS/WAAPI motion can remain native; only simulations need owned scheduling.
   Preserve reset/dispose for unsupported existing scripts.
2. Keep one input owner, automatic motion on the focused screen, and a conservative
   bounded warm set. Pause motion outside useful visibility; stop admissions during
   navigation and in hidden tabs. Coalesce focus/theme churn. Budget source/DOM
   complexity and measured work as well as document count. Validate low-end devices
   before enabling additional automatic previews.
3. Share compiled CSS with live documents. This prototype's localhost-only,
   authenticated endpoint is not the production CSS distribution interface.
4. Keep cooperative local state through safe theme updates, and use a versioned
   restore after fresh documents for structural changes. Reject incompatible state
   after content/design edits rather than guessing a migration.
5. Choose a bounded canonical poster scenario/time per frame. Transient actions
   never invalidate it or create a server render job. Add another saved scenario
   view deliberately rather than eagerly multiplying scenarios × themes × times.

This does not resolve the earlier faithful local-bitmap checkpoint problem.
Unknown overview variants still need actual rendering; a bounded pool cannot
instantly update 300 novel layouts and then reveal matching rasters without that
path. Retain cached first paint and the existing per-theme reuse while developing
the [broader live-canvas architecture](live-canvas-rendering.md) in stages.

## Independent review and next decisions

Astra independently reviewed production and prototype code at `79b72ea`, without
rerunning benchmarks. Its review supports the reusable pieces—content/theme
identity, cached opening, bounded work, shared compilation and one input owner—but
does not endorse a final rendering architecture.

The next experiments should answer these questions in order:

1. **Unseen overview convergence.** Use genuinely distinct designs, preview bytes,
   fonts/assets and mixed dimensions, with a target theme absent from every cache.
   Include changed component structure and heights. Compare bounded server
   convergence, a small persistent pool with idle local checkpoints and identical
   fallback, and prioritizing low-resolution visible server output. Measure correct
   visible pixel-area coverage over time, stale pixels after eviction, structural
   fidelity, navigation, memory, bytes, browser seconds and queue age. Include
   concurrent demand from multiple files: one global browser is a protective policy,
   not a validated capacity plan. If faithful checkpoints do not improve convergence
   enough within resource limits, describe new arbitrary-HTML variants as progressive
   rather than promising an instant dense overview.
2. **Actual device budgets.** Use the actual camera/planner, distinct posters and
   representative laptop/phone hardware for cold opening, sustained pan/zoom/input,
   background/resume and repeated eviction. Compare zero, one and four live
   documents and compiled CSS versus browser compilation. Measure memory growth,
   stalls and responsiveness before choosing defaults; a resized desktop viewport
   does not establish a phone budget.
3. **Minimum optional behavior contract.** Compare native motion with disposal,
   a small optional pause/state adapter and the full scenario/clock experiment
   across independently authored hover, spinner, carousel, deposit, order-book and
   canvas-chart examples. Include reduced motion, late-created utility classes,
   noncooperative timers, structural theme changes and incompatible revisions.
   Simple CSS/WAAPI behavior should require no scenario, seek or serialization code.
   Pause, state restoration, deterministic poster selection and seeking are separate
   capabilities; unsupported scripts retain explicit reset/dispose behavior.

These are decision experiments, not new measured guarantees. Keep engineering
complexity and client energy in the cost comparison: bounded browser-server
checkpointing may remain the best economic solution. Shared DOM on a dedicated
preview surface is worth reconsidering only for a demonstrated constrained
authoring subset. A native scene renderer would deliberately change the supported
design language; it does not follow automatically from these results.

The current PRs remain increments with different acceptance scopes:

- **PR26:** its cache and render-cost improvements stand independently. Uncached
  overview latency and queue contention still need capacity validation. This review
  identifies no architecture blocker, and is not a full correctness/security signoff.
- **PR28:** enabling interaction currently excludes the node from ordinary live
  previews, so an inactive enabled design remains on its poster even at close zoom.
  Theme changes recreate the session and discard local state; automatic motion is
  absent. These staging limitations prevent claiming that the PR completes the
  interaction-first model or preserves a deposit during theme comparison. Resource
  isolation limits also remain as documented in the playback policy.

The full review is preserved outside git at
`/home/srujangurram/.cache/agent-artifacts/sharpner/2026-11-01/151137-astra-architecture-review-a05708/astra-review.md`.

## Reproduce and evidence

On the experiment branch, copy the normal local config, then:

```sh
VITE_MOTION_EXPERIMENT=1 pnpm build
devcap pnpm preview --port 5200 --strictPort
```

Open an existing signed-in `/f/<file>` route with
`?prototype=motion&variant=pool&count=300&cap=4`. Variants are `reload`, `persistent`,
`pool`, `eager`; the eager control admits every screen. Avoid a 300-live run.
Use the bottom controls for manual behavior checks. In the browser console:

```js
const p = window.__motionPrototype;
await p.ready;
await p.benchmark({ strategy: "pool", count: 300, cap: 4, rows: 120, mode: "scheduled" });
// Compare caps 0/1/4/12/40, and modes simulation/scheduled/native.
// For long commands, retain the Promise and read the result after completion.
```

Raw matrices, final rechecks, lifecycle probes, independent policy review,
recording, screenshots and build/test logs remain outside git at:
`/home/srujangurram/.cache/agent-artifacts/sharpner/2026-11-01/142212-interaction-first-performance-e585c8/`.
The original runner and correctness scripts are preserved there too. One heavy
forty-screen evaluation exceeded the automation response deadline; its completed
result was recovered before continuing. No verification media is committed.

Validation: `pnpm test` passed (609 passed, 4 skipped; four workers),
`pnpm exec tsc --noEmit`, the opt-in production build and `git diff --check` passed.
