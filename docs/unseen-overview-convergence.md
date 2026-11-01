# Unseen overview variants: convergence experiments

These experiments test Astra's first objection: a bounded set of live documents
does not by itself update hundreds of unseen overview variants. The production
per-theme cache makes repeat switches cheap; a new content/theme pair still
requires rendering somewhere. No rendering architecture is final after this work.

The runnable code stays on
[`experiment/unseen-overview-convergence`](https://github.com/Royal-lobster/sharpner/tree/experiment/unseen-overview-convergence).
Only this report belongs in the shipping PR. Local capture, shared HTML, prototype
endpoints and diagnostic hooks are throwaway experiments, not enabled features.

## Workload and measurement

Local production build on the 64 GB Forge desktop, Chrome 156, 1280×800 viewport,
signed-in editor, actual Canvas/render planner/thumbnail cache. Forty and 300
distinct screens cover twelve families: analytics, trading, deposits, settings,
catalog, people, kanban, editorial, calendar, inbox, checkout and operations.
Widths range from 760 to 1200 pixels, with mixed fixed and automatic heights.
The 300-screen source is about 1.02 MB; all 300 change component structure in the
Editorial theme. Inter and Source Serif 4 are real loaded web fonts. The fixture
includes data images, SVG charts, forms and paused CSS motion. Forty server
previews have distinct WebP hashes; these are not repeated schematic posters.

Light is the baseline. Dusk changes tokens and fonts; Editorial also replaces
header/card component definitions. Initial generation and first theme switches
have no matching cached preview. Server measurements use one global browser,
four tabs and the normal scheduler/budgets. No quota override was used.

Fill time measures Canvas draw completion for the correct content/theme tuple,
weighted by projected visible frame area; it is not an image-diff metric or
physical input-to-photon timing. Auto-height changes alter that area during a run.
The overlay is not subtracted as an occluder. Readiness of all metadata alone does
not establish that every screen was painted. Timings exclude authentication,
initial source transfer and CSS preparation unless stated. Repeated-cache tests
use a synchronous theme-change clock; earlier zero-millisecond samples were a
clock-start error and are excluded.

Browser seconds are launch-through-close session wall time, a local proxy for
billed occupancy. Four simultaneous tab jobs overlap: their durations must not be
added to estimate browser usage. The amortized per-screen figures below divide
total session occupancy by displayed frames and therefore include the associated
design-system jobs, startup, uploads and teardown. Per-job median render time is
a different metric.

## Smaller server output

The control is PR26's compiled CSS, one sharp capture plus downscaled overview
WebP. The experiment captures only a 256-pixel or 128-pixel overview WebP for
ordinary frames. The explicit cover and design-system specimens retain the full
path. Ordinary frames alias `hi` to the small object; demand-generation of a sharp
tier is **not implemented**. This is not ready to replace the production preview
contract, close-zoom handoff, covers or agent APIs.

| 40-screen first switch | All painted | 95% area painted | Browser seconds/switch | Browser seconds/displayed screen | Frame render median | R2 objects, including specimens |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full output, Dusk | 6.650 s | 6.550 s | 4.730 | 0.1183 | 414 ms | 84 |
| Small 256, Dusk | 4.125 s | 4.058 s | 3.016 | 0.0754 | 264 ms | 45 |
| Full output, Editorial | 5.966 s | 5.816 s | 4.777 | 0.1194 | 426 ms | 84 |
| Small 256, Editorial | 4.348 s | 4.265 s | 3.139 | 0.0785 | 263.5 ms | 45 |

The full runs have 42 jobs: forty frames and two component specimens. Encoded
frame bytes fall from 1.19 MB to 0.165 MB for Dusk and 1.59 MB to 0.232 MB for
Editorial. Small capture cuts browser occupancy by 34–36%; it does not make a
new forty-screen theme instant. The initial Light runs took 5.341 s full and
2.944 s small; they include five design-system jobs rather than two, so compare
the theme-switch rows for like work.

After each theme was cached, Light, Dusk and Editorial all repainted within the
first sampled animation frame: measured draw completion 1.8–4.2 ms and **zero
browser seconds or new renders**. This is a local model-to-draw observation, not
a claim of 2 ms human input-to-photon latency. Earlier PR26 menu-to-repaint
measurements remain documented in [thumbnail rendering](thumbnail-rendering.md).

| 300-screen workload | All painted | 95% area | Browser seconds | Browser seconds/displayed screen | Frame render median | R2 objects |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Full output, initial Light | Did not fill: 275/300 at 120 s | Not reached | 32.455 | 0.1082 | 396 ms | 610 |
| Small 128, initial Light | 19.110 s | 18.294 s | 18.427 | 0.0614 | 215 ms | 311 |
| Small 128, new Editorial | 20.007 s | 18.207 s | 17.724 | 0.0591 | 207.5 ms | 305 |

All 300 full-output metadata rows were ready at about 33.8 s, but the decoded
256-pixel working set exceeded the existing 16-million-pixel cache budget. The
cache intentionally retained boxes for 25 screens; this was not unfinished server
work or failed downloads. Right-sizing output lets all 300 fit the same budget.
Encoded frame bytes are 9.55 MB full versus 0.537 MB small initially, and 0.639 MB
for small Editorial. This supports resolution selection rather than raising the
decoded-memory ceiling. It still takes twenty seconds to converge on a new dense
overview, so it fails the desired quick-adaptation experience.

A 30-second pan probe used the actual camera with all 300 distinct small posters
ready: frame interval p95/p99 33.4/33.4 ms, maximum 33.5 ms, 1,332 frames. The
prototype's per-frame coverage collector remained active and adds work. This is
not a GPU FPS reading or a low-end-device budget. No physical phones or low-end
laptops were available; simulator availability does not establish their speed.

## One shared browser under contention

Ten files each submitted eight distinct screens with real viewing presence and
small output. The first file's eight metadata rows were ready at 2.136 s; the last
at 11.920 s. First-thumbnail readiness ranged from 1.803 to 11.588 s. All files
completed, using 10.301 browser seconds in total, with no starvation in this
sample. The artifact's 16.703 s outer duration includes final diagnostic requests
and is not queue completion time. This test measures metadata delivery, not ten
simultaneously painted canvases.

One global browser bounds cost and concurrency, but serial demand produces a
visible queue tail. Admission also reserves 45 seconds before a turn, so a nearly
spent daily budget can defer work before its numeric cap. Protective quotas are
not free throughput. Capacity and latency need production queue-age telemetry;
raising parallel browsers should follow measured demand rather than be the
default response to an expensive renderer.

## Local checkpoints through two documents

The capture experiment warms at most two normal `frameDocument` iframes, freezes
canonical motion, serializes supported HTML/styles/fonts through SVG
`foreignObject`, encodes a 256-pixel WebP, displays it locally and uploads batches
through the room. The explicit cover remains a full server capture. A conservative
feature gate rejects unsupported content; this is a local protocol, not a
production capture/security design.

For forty screens switching to Editorial, 39 local captures were accepted. Half
the visible area was current at **1.471 s**, 95% at **2.954 s**, and all forty at
**4.354 s**. Server fallback for the cover and two component specimens used
**0.538 browser seconds**: 0.0135 seconds amortized across forty displayed
screens, versus 0.0785 for small-server output. Five local upload batches wrote
39 objects (about 191 KB), plus six server objects. Total completion is almost
the same as the small-server run: fallback starts after local uploads in this
prototype. Its benefit is earlier coverage and 83% less server occupancy, not
instant convergence. Frame intervals reached 66.8 ms maximum, without a measured
parent long task above 50 ms.

CSS preparation took 459.8 ms for the authenticated warm request, 2 ms reported
Worker wall time and about 551 KB including embedded fonts. Those figures are
not Worker CPU or cold-load measurements. A representative styled capture took
59.6 ms to warm plus 65.7 ms to capture, including 25.6 ms serialization, 31.2 ms
SVG decode and 7.9 ms encoding.

All forty local/reference image dimensions match. After masking the bottom 16
pixels containing different generated file identifiers, RGB mean absolute error
is 2.58–6.04/255 for local captures; the server cover control is 0.34. Font/layout
landmarks and visual inspection support feasibility at overview size, but form
and edge differences remain. Encoding an origin-clean image is not proof of
pixel identity. Cross-origin images, arbitrary fonts, canvas/video, filters,
shadow DOM and existing authored code need explicit fallback and corpus tests.

The first capture probe accidentally received application HTML at its CSS URL.
Its unstyled output and timing are invalid; the route was corrected and stylesheet
loading checked before the runs above. Both failed and corrected artifacts are
retained so the setup failure cannot be mistaken for a renderer result.

## Restricted shared HTML surface

One opaque iframe can hold idle declarative fragments under a shared compiled
stylesheet, using the existing component expander. Each frame has a separate
geometry/theme host; authored JavaScript does not run, and idle hosts are inert.
The prototype rejects full documents, source styles/scripts, inline viewport
units, viewport rules it recognizes in authored token CSS, document-root font
changes, unsupported resources and duplicate IDs. This is an optional representation of eligible screens, not a
replacement rendering language or a claim that arbitrary HTML is safe to share.

On this fixture all 300 qualify: about 33,000 descendant elements and 1.02 MB of
source. Initial ready acknowledgement took **826 ms**, including child setup and
probe transfer but excluding CSS preparation and source fetching. Twelve warmed
switches took **361–413 ms** for token/font-only changes and **535–729 ms** when
component structure changed. They use **zero server browser seconds and zero R2
writes**. Initial structural exit to Dusk took 947 ms separately. These timings
are child/parent readiness acknowledgements after rendering opportunities, not
pixel-diff fill times or physical input-to-photon measurements.

Across twelve screen families in three themes, 36 normal-document comparisons
matched sampled landmark geometry to within 0.1 CSS pixel and matched sampled
fonts/body styles. Auto-height measurements differed by at most one pixel due to
integer rounding. A fixed-height host's scroll height can exceed normal body
content height and is not an auto-height comparison. These checks do not prove
full screenshot identity or eligibility of the existing real-file corpus.

The speed comes with unacceptable synchronous work in the initial version:
theme-run animation-frame gaps reached **600 ms**, with p95 **516.6 ms**. A
half-second editor stall fails the performance goal even if the whole overview
updates much earlier than server screenshots. Shared rendering must budget
style/layout/paint and yield work, not merely count documents.

Batching trades stalls for slower convergence. Four switches at each batch size
gave these ranges, on the same 300-screen shared surface:

| Hosts per batch | Complete theme acknowledgement | Worst frame interval per switch |
| ---: | ---: | ---: |
| All at once | 447–501 ms | 324–433 ms |
| 8 | 1.50–1.72 s | 50–67 ms |
| 16 | 1.00–1.77 s | 67–133 ms |
| 32 | 0.98–1.32 s | 167–200 ms |

These samples are not randomized hardware benchmarks. Eight-host batches avoid
the largest stall, but do not make a new overview instant. This does not settle
the architecture. The thirty-second shared-surface camera probe recorded 1,651
frames, interval p95 33.3 ms, p99 50 ms and maximum 66.7 ms, compared with the
cached raster probe's 33.4/33.4/33.5 ms. The shared document does not establish a
better sustained camera budget merely because it avoids server generation.

Seven deliberate unsupported cases rejected full HTML, scripts, canvas,
viewport units, automatic error handlers, root-font changes and cross-preview
duplicate IDs. For the duplicate case the first host remained and the second
fell back. This checks conservative routing on those cases, not production
sandbox security or arbitrary CSS equivalence.

Astra's second review found a concrete gap: the classifier does not inspect the
compiled CSS loaded from `cssUrl`. Tailwind classes such as `fixed`, `w-screen`
and responsive utilities can therefore introduce viewport-dependent behavior
without triggering the authored-CSS checks. This is a code-review finding, not
a reproduced visual failure. The syntax gate is incomplete; a future tier needs
an explicit authoring capability and validation of expanded markup and emitted
CSS. Successful fixture checks do not establish that real files qualify.

Adding `contain: layout style paint` to each host was a modest improvement,
not a solution. Four unbatched transitions took 357–510 ms, versus 387–712 ms
in the immediately preceding control, with worst frame gaps still 333–450 ms.
Contained eight-host batches took 1.50–1.64 s and reached 50–67 ms gaps.
This sequential local sample is not randomized, and containment can alter CSS
semantics; it remains an explicit experiment policy.

A Dusk frame override remained Dusk while the file switched between Editorial
and Light. The other 299 hosts rebuilt; the overridden frame's sampled styles
matched a normal Dusk document and maximum landmark delta was 0.002 px. The
prototype snapshots overrides at shared-surface creation; it does not yet track
arbitrary content or override edits in place. The final actual-menu recording
also shows Light/Dusk/Editorial and camera motion. Recording adds substantial
overhead, so its frame timings are excluded from the comparison above.

## Cost implications

Use the same illustrative workload as [the PR26 model](thumbnail-rendering.md):
three files of 200 screens, 4,000 edited screens and 6,000 viewed content/theme
pairs generated monthly after lazy admission, plus 300 explicit screenshot
screens. Browser/session and capture numbers above are local measurements;
monthly totals below are extrapolations, not invoices or production CPU readings.

| Path | Browser hours/team/month, including estimated explicit screenshots | Automatic concurrency | Preview PUTs/month | Rough marginal thumbnail cost/team/month |
| --- | ---: | --- | ---: | ---: |
| Original pipeline, prior model | 1.81 | Unbounded across active files | 56,000 | $0.44–0.47 |
| PR26 full output/cache/budgets, prior model | 0.258 | One shared browser | 12,000 | About $0.10 |
| Experimental overview-only server output | 0.14–0.17 | One shared browser | About 6,100–6,750 | About $0.06–0.08 |
| Experimental local checkpoints, assuming the measured eligibility/composition | About 0.064 | One shared fallback browser | About 6,750 | About $0.06 |

The latter rows use measured amortized occupancy, including fixture cover and
specimen overhead, and assume 0.5 browser-second per explicit screenshot. Local
eligibility and real cover/edit patterns are unknown; these are optimistic
planning cases. Client-only and hybrid approaches still write checkpoints and
serve them to other viewers. A shared declarative surface can avoid generating a
new image for each local theme comparison, but it has no implemented durable
poster/cover policy here; assigning it a full monthly saving would be premature.

Rates checked on 2026-11-01: $0.09 per additional browser-hour, with ten hours
and ten concurrent browsers included account-wide; concurrency is the monthly
average of daily peaks. A single shared slot avoids extra concurrency charges
from this subsystem. [Cloudflare Browser Run pricing](https://developers.cloudflare.com/browser-run/pricing/).
R2 Standard costs $4.50/million PUTs, $0.36/million GETs and $0.015/GB-month before
shared allowances. [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/).

For example, 6,100–6,750 PUTs cost $0.027–0.030, while 50,000 uncached GETs cost
$0.018; 90% edge hits reduce that GET component to $0.0018. Retaining two themes
for 600 screens is roughly 2–7 MB with these small outputs, plus selected sharp
covers/specimens, versus the prior full-output model's approximately 34 MB.
Storage remains below $0.001/team/month at these sizes. A planning allowance of
10–50 ms Worker CPU/pair is $0.001–0.006 for 6,000 pairs, before scheduler/room
request and active-duration overhead. It has not been metered in production.
[Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/).

The clear economic gain after per-theme reuse is fewer objects and less unused
resolution. Replacing the right-sized server renderer with client capture saves
only another roughly cent per team in this workload, while introducing fidelity,
client energy and coordination work. That tradeoff could still be worthwhile for
latency, but server-cost savings alone do not justify a rushed primary capture
path. Global daily quotas bound expenditure; they also defer demand and must not
be represented as meeting unlimited-team latency.

## Recommendation and next gates

Keep PR26's identity/cache model, compiled CSS, single capture, lazy admission,
debounce, pair deduplication and global fairness as independent wins. A resolution
tier selected for projected size is the next clear optimization, provided sharp
requests and handoffs are designed and tested. Keep authoritative server covers
and explicit screenshots until alternate fidelity is demonstrated.

For adaptation, continue the restricted shared-HTML experiment only with strict
work and fidelity gates. Preserve a raster fallback and bounded isolated runtime
for input/unsupported code. Idle representation and focused interaction are
execution modes of the same screen, not separate screen kinds. CSS/WAAPI motion
should not require scenarios, seeking or serialization; state restoration remains
an optional capability. No experiment here makes it reasonable to run hundreds
of active simulations.

Before choosing defaults, measure the eligible fraction of actual files, new
content edits and variant churn, automatic-height and override correctness,
eviction/handoffs, sustained camera performance, source/decoded/DOM memory, and
target-device input latency. The small-server result is a faithful progressive
fallback; the current shared result is a faster but still blocking prototype.

Astra's follow-up review agrees that all-shared DOM should remain experimental.
The next timeboxed test should use actual files, with the dense 300-screen fixture
as a negative control: first establish useful eligibility, then schedule updates
by projected area and measured work while keeping raster fallback. Culling alone
cannot solve a view containing all 300 screens. Test variant changes during pans,
rapid superseding edits/themes, pan-away/return, painted coverage and memory.
Provisional gates are 95% correct visible area within one second for warmed
eligible comparisons, no parent long task above 50 ms, and camera performance
close to raster. These gates have not been achieved or device-qualified.

Keep one screen identity with several valid representations, explicit resolution
and fallback, cancellable work budgets, a single owner for geometry/handoff, and
one isolated input owner. Optional motion/state adapters do not need to become a
mandatory scenario framework. A native WebGL rewrite would require reproducing
HTML layout and rendering; this evidence does not justify that fidelity burden.

## Reproduce and evidence

Copy the normal gitignored local configuration into the experiment checkout:

```sh
devcap pnpm prototype:overview
```

Open a signed-in file with `?prototype=overview&count=40&mode=full`. The prototype
controller is `window.__overview`; create a new synthetic file with
`await p.create(40, "full")`, navigate to its returned URL, then `await p.seed()`.
Seeding requires an empty file and writes only `PROTOTYPE · overview` files.
Use `await p.server("dusk", "full")` and retain `p.finished`; inspect
`await p.resultWithCost()` after it settles. Compare modes `overview` (256) and
`overview128` (128) in fresh files. `p.local("editorial", 2)` runs local checkpoints;
`p.sharedStart()` enables the restricted shared surface. Long automation commands
should retain their Promise and read the completed result later.
The prototype toolbar also offers New 40/300, Seed fixture, Shared HTML, Batch 8,
Unbatched and Posters. Switch themes with the normal editor file-theme menu.
`await p.shared.policy(8, true)` selects eight-host batches with containment;
`await p.shared.policy(0, false)` restores the original all-at-once control.

Raw timings, queue diagnostics, paired WebPs, failed setup evidence and geometry
probes are outside git at:
`/home/srujangurram/.cache/agent-artifacts/sharpner/2026-11-01/151959-unseen-overview-convergence-42335e/`.
No verification media is committed. The report records local experimental scope;
it does not constitute a deployment, architecture signoff or device qualification.
The preserved branch passes `pnpm test` (609 passed, four skipped),
`pnpm exec tsc --noEmit` and its experiment production build. The actual-menu
recording and Light/Dusk/Editorial screenshots are in the artifact `media/`
directory; no PR attachment mechanism was available.
