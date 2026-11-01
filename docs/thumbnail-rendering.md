# Thumbnail rendering

> 2026-11-02: theme switching was removed. Sharpner renders exactly the HTML an
> agent wrote and never applies a theme, so previews have no theme dimension:
> one preview per node and content revision. Sections below that mention
> per-theme pairs, theme debounce or cached theme switches describe the earlier
> design and the measurements taken under it. A migration baked each formerly
> themed frame's theme into its HTML roots, so existing screens look the same.

Previews are keyed by content revision. `nodes.rev` changes for source, size and
design-system dependencies, including component definitions.

Each node row holds the latest content revision, two immutable URLs, its
measured height and a retry count. Library changes continue to invalidate
dependent revisions.

The renderer uses `frameDocument`, component expansion for
both screenshots and previews. Tailwind 4.3.3 is pinned for live documents and
server compilation. A bounded compiler cache is keyed by the actual token and
authored Tailwind CSS, so it is naturally invalidated by design-system changes.
Styles are seeded before load; a second pass collects actual expanded DOM classes
and styles, including props, slots, authored theme contexts and scripts.
Shared Google Fonts styles and font bytes are fetched before browser launch,
with bounded caching and an original-link fallback. Other font providers retain
normal browser loading. One WebP capture produces the sharp tier; a detached
canvas derives the overview tier. Frames no wider than 256px share one object.

## Admission and limits

`THUMBNAIL_POLICY` in `worker/thumbnail-policy.ts` centralizes the knobs:

| Policy | Default |
| --- | ---: |
| Automatic browsers, across the deployment | 1 |
| Browser tabs in a turn | 4 |
| Edit debounce | 1.2 seconds |
| Fair turn / hard session deadline | 8 / 20 seconds |
| Reserved time before admission | 45 seconds, refunded to measured elapsed time |
| Daily automatic browser time per file | 90 seconds |
| Daily automatic browser time per workspace | 180 seconds |
| Daily automatic browser time globally | 900 seconds |
| Queued files | 1,000 |
| Attempts per node revision | 3 |

The shared Durable Object rotates workspaces, then files. A busy file keeps one
browser session across its batches until its fair turn expires; it does not
launch another browser per 24 nodes or retain an idle browser between turns.
Persistent leases and conservative reservations protect admission across
restarts and failures. Explicit `screenshot_nodes` requests use the same browser
slot and the file's serialized browser work, with bounded waiting and session
time. Their usage is logged separately and is outside automatic daily quotas.

Each node keeps exactly one preview. Viewed pages render before other pages.
Per-edit browser time is one render per edited node, regardless of how many
themes the tokens declare.

No automatic browser launches for a file without an active, unexpired viewing
socket. Explicitly selecting an uncached cover is an exception: only its current
pair renders, through the same budget, and the request clears when it lands.
A new page presence resumes a file's other pending work. Rapid changes are coalesced;
revisions and a design-system generation check reject raced renders. Unique
attempt URLs prevent late uploads from overwriting or deleting a retry. The
selected fallback remains owned until its replacement lands. Background renders
never change active heights. The existing live/thumbnail handoffs remain in use.

Admission requires room for the entire reservation, so a nearly exhausted budget
can defer work before the numeric limit is reached. At a budget limit, new previews wait until the next UTC day; cached switches and
live frames still work. Missing `THUMBNAIL_QUEUE` configuration disables automatic
work instead of bypassing the budget. Add the binding and `v2` Durable Object
migration from `wrangler.example.jsonc` when deploying.

The default global cap is intentionally a small shared allowance: 900 seconds/day
is at most 7.5 browser-hours in a 30-day month, leaving some included usage for
explicit screenshots. It cannot supply unlimited active teams. Raise it using
observed queue delay and per-team demand; the cost estimates below assume the
requested work is admitted, rather than treating deferred work as free capacity.
At the measured throughput, 1,000 teams with the modeled workload need about
216 automatic browser-hours/month, still below one continuously occupied browser.

## Local measurements, 2026-11-01

A real signed-in editor at overview zoom displayed forty 1200×1000 analytics
frames with shared tokens, Inter web fonts, a reusable button and Light/Dark
presentations. Local Browser Run, four tabs in one browser. No production or
Cloudflare invoice measurements are implied.

| Measurement | Before | After |
| --- | ---: | ---: |
| Render/load/capture time per screen, median | 724 ms | 480 ms |
| Render/load/capture time per screen, p95 | 1,232 ms | 579 ms |
| Browser-session seconds per rendered node | 0.222 | 0.130 |
| First uncached theme switch, forty screens filled | 10.982 s | 6.720 s |
| Browser-seconds for that switch, including its component specimen | 9.111 s | 5.326 s |
| Repeat switch to a previously rendered theme | 10.558–10.841 s | 31.3–33.1 ms |
| Browser-seconds on repeat switch | 8.702–8.970 s | 0 |

Browser time is measured launch-through-close wall time, divided by 41 nodes for
the per-node figure; it includes browser startup, R2 upload waits and teardown.
It is a conservative local proxy for billed browser lifetime, not the sum of tab
wall times. First-switch fill latency includes debounce, scheduling and delivery;
repeat-switch latency measures the actual canvas repaint after the menu selection.
All forty frames repainted with zero dimmed draws and no live iframes. The same
interaction was checked at 390×844 and 1280×800, with screenshots and a recording
kept outside the checkout.

For a representative screen in both Light and Dark, old live/JIT and new compiled
paths produced identical decoded 1200×1000 WebP pixels and matching measured
heights: 0 different pixels out of 1,200,000 per theme. This is fixture evidence,
not a claim about every possible authored script or external resource.
The overview raster intentionally resamples the sharp WebP rather than capturing
layout twice. Average tier sizes on the fixture were 2.4 KB and 25.4 KB.

Theme switching (file-wide, removed 2026-11-01, then per-frame, removed 2026-11-02)
no longer exists, so the multi-theme figures below are historical.

Each additional used theme after a content edit costs approximately another
0.130 browser-seconds, two R2 PUTs and 28 KB of retained images per rendered
screen at this fixture's complexity. Unused themes cost nothing. Warming two
used themes doubles the pairs generated for an edit; caching removes repeated
switch rendering, and lazy admission avoids unviewed edits.

## Cost comparison and recommendation

This is an incremental thumbnail/screenshot cost model, not the cost of the whole
product. It excludes Clerk, the shared Workers plan fee, ordinary file operations,
and any client device cost. It uses marginal rates before shared included usage:
[Browser Run](https://developers.cloudflare.com/browser-run/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[Workers](https://developers.cloudflare.com/workers/platform/pricing/) and
[Durable Objects](https://developers.cloudflare.com/durable-objects/platform/pricing/).
Those allowances are account-wide, not per team. Browser concurrency is billed
using the monthly average of daily peaks.

Assumptions for one active team:

- Three existing files of 200 screens; 20 workdays/month.
- Ten edit bursts/day touching 20 screens: 4,000 screen content changes/month.
- Six file theme toggles/day affecting 200 screens: 24,000 old-pipeline renders.
- Two used themes. After lazy admission, 75% of edited content pairs are viewed
  before the next revision: 6,000 generated pairs/month after this change.
- 300 explicitly requested screenshot screens/month. Estimate 1 browser-second
  each before, 0.5 after; these explicit costs are estimates, not measured here.
- 50,000 R2 GETs/month before edge/browser caching; roughly 28 KB per stored pair.
- 10–50 ms of Worker CPU per generated pair as a planning range. Production CPU
  metering is still needed; local wall-clock measurements are not CPU readings.

| Architecture | Browser hours/team/month, including explicit screenshots | Automatic browser concurrency | R2 PUTs/month | Typical incremental total/team/month |
| --- | ---: | --- | ---: | ---: |
| Existing server pipeline | 1.81 | One per active file; no shared cap | 56,000 | $0.44–0.47 |
| This PR: compiled CSS, single capture, cached themes, lazy/fair admission | 0.258 | One shared browser, also shared with screenshots | 12,000 | About $0.10 |
| Client capture for all eligible viewed screens, server only for explicit screenshots | 0.042 | Zero automatic; explicit work uses the shared slot | 12,000 | About $0.08 |
| Hybrid, assuming 75% of viewed pairs can be faithfully captured by clients | 0.096 | One shared fallback slot | 12,000 | About $0.09 |

At $0.09/browser-hour, browser duration contributes about $0.163 before and
$0.023 after. Two PUTs/pair at $4.50/million cost $0.252 before and $0.054 after.
50,000 uncached GETs cost $0.018; a 90% edge hit rate reduces this to $0.0018.
Current R2 storage is about 17 MB before and 34 MB with two cached themes, under
$0.001/team/month at $0.015/GB-month. Four themes plus a fallback stay bounded.
Worker CPU is approximately $0.001–0.006 after this change; allow another few
mills for scheduler/room requests, SQLite and active duration. These are rough
estimates; real CSS complexity, edit patterns, external assets and cold starts
change the result. If every edit is viewed, automatic pairs rise from 6,000 to
8,000 and the after estimate rises by roughly $0.02–0.03/team/month.

The unbounded old concurrency can dominate the duration saving: twenty browsers
at each daily peak would add $20/month above the ten included browsers. With the
new single shared slot, this subsystem stays within the included concurrency.
For 1,000 modeled teams with sufficiently raised duration budgets, the marginal
thumbnail/screenshot estimate is roughly $100/month before shared allowances;
the default protective quota will defer that workload until explicitly raised.

**Recommendation:** ship this bounded server path first. Its marginal cost is
already a few cents to about ten cents per active team, while preserving the
browser's actual layout and pixels. DOM capture would save roughly another
$0.01–0.02/team/month in this model; most remaining expense is R2 operations.
Do not make an unproven capture library the primary path for that small saving.

For interactive adaptation, follow the [live canvas experiments](live-canvas-rendering.md).
Persistent browser HTML changed forty warmed screens in 51–55 ms without server
work, while optimized SVG capture still took about 2.4 seconds. The current PR
added a conservative theme fast path for already-live documents (since removed with theme switching). A broader
overview implementation needs bounded hydration and a faithful bitmap handoff;
it is separate from the server-cost optimization above.

Client capture cannot read compositor pixels from an ordinary web page. Current
live frames use `sandbox="allow-scripts"`, so their opaque origins also prevent
parent DOM access. An in-frame SVG/DOM rasterizer would need to inline fonts,
styles and images; cross-origin image display does not imply canvas readback is
allowed. CSS filters, pseudo elements, canvas/video content and font substitution
need fidelity tests. Removing sandbox isolation to simplify capture would expose
the app to authored scripts.

If production demand warrants a hybrid, implement it as a separate capability:

1. Add an opt-in capture protocol inside the isolated frame runtime. Reuse its
   existing rendered content; capture only while the editor is idle and visible.
2. Resolve assets through a bounded, authenticated byte bridge without changing
   sandbox privileges. Feature-test supported CSS and reject tainted/unsupported
   captures rather than publishing degraded previews.
3. Have the room validate node revision, dimensions, payload size
   and request ownership. Deduplicate competing clients before R2 writes and use
   the same immutable pair table and stale-write checks.
4. Compare fonts, foreign images, authored theme contexts against
   server goldens; measure eligibility, battery cost, latency and failure rates.
5. Keep server fallback within this scheduler's budgets. Preserve authoritative
   server screenshots and covers until fidelity is demonstrated.

Other options: only render the currently viewed page or reported viewport, which
can reduce unused work without changing rendering fidelity; use one overview
object and demand-generated sharp covers to cut PUTs further, after auditing
close-zoom handoffs; or use a small shared browser container. A container can
amortize a fixed bill but adds operations work and a persistent resource floor.
None gives a free, faithful browser compositor in a Worker. These are follow-up
choices, not partly implemented paths in this PR.
