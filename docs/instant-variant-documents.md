# Instant variants with bounded browser documents

Cached themes are already URL swaps. This experiment addresses new content/theme
pairs by retaining normal HTML documents, with bounded server rendering for
durable images. The owner's gate is **under three seconds for an uncached visible
variant**. Prepared-editor, cold-document and fully cold costs are reported
separately. The forty-screen prepared-editor case passes locally; fully cold and
dense cases remain unsolved. This is not a final architecture.

## Real files changed the direction

A read-only export supplied 379 frames and 412 component definitions. Production
designs were never modified. Private sources, compiled sheets and media stay
outside git.

| Anonymized file | Frames | Definitions/file | Earlier shared-fragment eligibility | Dependency closure, median / maximum |
| --- | ---: | ---: | ---: | ---: |
| A | 293 | 164 | 0 | 11 / 22 definitions |
| B | 15 | 226 | 0 | 26 / 56 definitions |
| C | 71 | 22 | 0 | 4 / 8 definitions |

The [shared-fragment tier](unseen-overview-convergence.md) rejects the source CSS,
document links and authored theme contexts common in Files A/C. Thirteen File B
frames pass fragment syntax alone, but twelve use `min-h-screen` and one
`h-screen`. Emitted Tailwind contains `min-height:100vh` and `height:100vh`,
which would refer to the shared document's viewport. The compiled-CSS admission
gap is confirmed statically, not through a screenshot mismatch.

Whole-file component limits also reject unused definitions. Literal dependency
closures are smaller, but pruning cannot repair incompatible CSS semantics.
File A's frame source totals 23.39 MB; six feature pages individually exceed the
old 2-MiB source limit. The 1-MB synthetic fixture was not representative.
This static classifier/HTML/compiler audit establishes no runtime pixel fidelity,
but its **0/379 admission** result rules out that narrow tier for this corpus.

## Preserve normal document semantics

The new prototype uses normal `frameDocument` iframes: full HTML, source CSS,
root/body attributes, native viewports and original asset bases remain intact.
A compiled file Tailwind/token sheet is shared. Each frame receives the literal
transitive closure of referenced tags, including all their theme definitions.

These are idle, input-free representations. Authored scripts, automatic handlers
and active/scripted media fall back. A nonce CSP permits trusted renderer code
and blocks user-event execution. Attributes such as `onclick` remain present
because authored CSS can depend on them. The explicit idle capability avoids a
conservative guard unnecessarily reloading Tabs/Accordion markup; it does not
permit hundreds of authored simulations.

| Prototype policy | Default / bound |
| --- | --- |
| Admitted screens | 40, configurable up to 300 |
| Source snapshot | 32 MiB including design definitions |
| Fresh-document commands | Four in flight, capped at eight |
| Warm theme commands | 32 in flight, capped at 64 |
| Parent dispatch | Yield after about 4 ms; prioritize visible area then distance |

Replacement documents can overlap old ones up to the cold-command allowance.
These are admission limits, **not measured process-memory or battery budgets**.
Generations cancel old work and reject stale completions. Cold replacements stay
hidden until ready over the old layer/raster; warm updates dim until acknowledged.
Cold assets roll back to fresh rendering. Eviction/handoff remains experimental.

## Forty real screens: cold and prepared are different

Local production-build tests ran in the actual signed-in editor on the Forge
Linux desktop. File A supplied forty HTML screens with screenshot-verified,
visibly different Light/Dark palettes, loaded fonts and a 3.667-MB source/design
snapshot. All forty are fixed-height. No physical-device qualification is implied.

| Condition | Theme command to all forty current | Scope |
| --- | ---: | --- |
| First local hydration, CSS preparation included | **3,545.6 ms — fails** | 1,456.4 ms preparation and 1,550.7 ms document startup, plus coordination |
| CSS already prepared, no target documents/bitmap | **2,065.8 / 2,304.3 / 2,120.5 / 2,562.8 ms** | Four independent local hydration runs; source, fonts/assets warm |
| Retained documents, genuine switches while panning | **121–242 ms** | Eleven switches; forty documents retained |

The prepared-editor runs use an already available CSS snapshot, not a newly
implemented production preparation/invalidation cache. They meet three seconds
under their stated conditions, not a fully cold-opening promise. The initial
1.456-second preparation remains part of session cost. Authentication and initial
source acquisition were not included. Local commands used **zero Browser Run
seconds and zero R2 writes**.

In the three repeated prepared-editor hydrations, parent frame interval p95 was
33.3 ms, maximum 33.4 ms, with no parent long task above 50 ms. The eleven warm
switches had p95 33.4 ms, p99 66.7 ms and maximum 100 ms; timer lag p95 30.6 ms,
maximum 88.6 ms, with no measured parent long tasks. Fast convergence does not
establish uniformly smooth navigation or human input-to-photon/INP latency.

File C's earlier Light/Dark palettes are effectively identical. Its 144–254-ms
32-command and 67–101-ms 64-command runs measure protocol/retention behavior,
**not visible variant convergence**. They must not substitute for File A.

Readiness validates generation, sampled layout and rendering opportunities.
Area coverage derives from ready/current documents, not a screenshot diff proving
every final pixel. The prototype explicitly holds the automatic server queue:
without a production demand seam, a local overlay could still trigger redundant
server renders for the same selected pair.

## Dense real-file negative control

The real 293-screen File A replaces another synthetic 300-screen rerun; earlier
synthetic measurements remain in the prior report. It has 292 fixed-height
frames and one auto-height frame.

| Dense condition | Result |
| --- | --- |
| Default forty admitted | Forty current covers **19.38%** of actual visible area; not a filled overview |
| All 293, CSS prepared, eight fresh commands | **15.5945 s** end to end; 92,156 DOM elements; 24.219 MB source/design snapshot |
| One stable warm theme command after hydration | **1.2918 s**, all 293 current |
| Theme every 800 ms while panning | First five superseded; final theme takes **12.429 s** |

Dense cold hydration reached 66.7-ms frame p95, 133.4-ms maximum and a 144-ms
parent long task. Churn created 511 documents, peaking at 301 (293 plus eight
replacements); frame p95/max were 166.7/183.4 ms, timer lag p95/max 240/263.9 ms,
and seven parent long tasks reached 118 ms. This explicitly fails the cold
three-second and responsiveness goals. The stable warm result does not establish
robustness under churn. Process memory/CPU, physical devices and post-eviction
return were not measured; DOM/source counts cannot stand in for those budgets.

## Fidelity checks and failures

Fresh browser-JIT comparisons covered four real frames in two themes for each
of Files A and C: eight comparisons per file. Sampled geometry, computed root/body
styles, font properties and height had zero deltas. File C remains a same-palette
control. These probes are not full image equality or auto-height validation.

The optional hot component engine initially failed seven-case/three-theme
comparisons: nested slots produced **48.117-px** landmark error and an
escaped-prop/slot case **182.078 px**. Snapshotting raw slots changed stock
expander semantics. The guarded rerun uses stock fresh documents for three
nested-component cases and reports **zero geometry/style/font/height deltas in
all 21 comparisons**. That supports conservative fallback, not general hot refresh.

Merged library/local definitions, source/design invalidation and arbitrary
structural replacements still need production tests. Astra recommends retaining
only the established token/theme fast path initially and using fresh canonical
documents for structural changes. Do not ship the optional hot component engine
alongside that smaller capability.

The reference probe initially waited for offscreen animation frames that never
arrived. Those reference-deadline failures are invalid renderer evidence.
Corrected reference probes use fonts, timers and layout, without a paint claim.
Further readiness gaps remain: CSS background images are not covered by
`document.images`, and assigning a measured auto-height can change viewport
layout afterward. Final post-resize geometry and painted output are unverified.

## Server atlas: throughput experiment, not a completed fallback

The atlas places normal isolated documents in one browser page, shares compiled
CSS, streams sources eight at a time and takes one CDP WebP screenshot. It uses
the existing shared browser lease. No R2 upload, durable atlas format or delivery
protocol is built.

| Forty-screen server path | End to end | Browser occupancy | Occupancy / screen |
| --- | ---: | ---: | ---: |
| Individual 128px captures, four tabs / one browser | Not measured here | 7.117 s | 0.1779 s |
| Atlas with intercepted shared CSS | 3.9956 s | 2.303 s | 0.0576 s |
| Atlas with blob CSS | 5.0735 s | 3.383 s | 0.0846 s |

The intercepted run spent 1,071 ms preparing, 1,884 ms loading, 253 ms capturing
and 19 ms decoding, plus coordination. It handled 2.837 MB source, 1.472 MB CSS,
12,532 DOM elements and 83 requests. Blob transport used 905/2,865/323 ms for
preparation/load/capture and 89 requests. These uncontrolled single samples prove
no speed win from the transport change. Both forty-screen runs fail three seconds.

Three atlas/individual WebP comparisons have RGB mean absolute errors
**1.21 / 2.50 / 4.89**; the third also differs in height, 90 versus 89 pixels.
Pixel identity is unaccepted. The dense 293-screen atlas timed out at its
20-second deadline, consuming **21.008 browser seconds** including close, with
no resulting image or R2 write. A single capture can reduce per-screen browser
occupancy without meeting latency, fidelity or complete publishing requirements.

## Recommendation and cost scope

Astra's independent review favors the smallest bounded normal-document tier:
token/theme updates for viewed idle screens, fresh canonical structural changes,
and the existing conservative raster/server fallback. Prepare immutable CSS by
the complete source/design/library/compiler identity, deduplicate preparation,
and fetch closures by admission rather than eagerly hydrating the whole file.

Make demand explicit: locally satisfied transient comparisons should avoid
redundant server screenshots, while covers, other viewers needing posters,
exports and unsupported content retain canonical demand. The experiment's queue
hold is not that production coordination protocol. Dense cold performance,
paint readiness, memory/device budgets and eviction remain unresolved gates.

No new monthly saving is claimed. The prior model estimates roughly $0.44–0.47
per active team/month originally and $0.10 for [PR26](thumbnail-rendering.md);
fallback prevalence, durable image operations and client cost decide any further
saving. A fast local command is not a complete zero-cost thumbnail pipeline.

Everything remains prototype work; nothing has been merged or deployed. The
[preserved executable experiment](https://github.com/Royal-lobster/sharpner/tree/d2cbfb4)
runs with `devcap pnpm prototype:overview` after copying the normal gitignored
local configuration. The optional origin uses `devcap node worker/overview-origin.prototype.mjs`.
Routes require the experiment flag, localhost and a `PROTOTYPE` file prefix.
Verification: 609 tests passed, four skipped; typecheck and experiment/production
builds passed. Private sources, names, media and raw diagnostics stay outside git
under `~/.cache/agent-artifacts/sharpner/2026-11-01/164057-budgeted-shared-overview-f26144/`.
