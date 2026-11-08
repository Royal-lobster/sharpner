# Thumbnail rendering

> 2026-11-02: theme switching was removed. Sharpner renders exactly the HTML an
> agent wrote and never applies a theme, so previews have no theme dimension:
> one preview per node and content revision. Sections below that mention
> per-theme pairs, theme debounce or cached theme switches describe the earlier
> design and the measurements taken under it. A migration baked each formerly
> themed frame's theme into its HTML roots, so existing screens look the same.
>
> 2026-11-08: a token sheet shows every distinct theme inside each swatch (Dark
> and Light side by side) as the file's foundations, replacing the dark-only pane
> below. A migration rendered every token sheet once more.
>
> 2026-11-02, later: design-system specimens present the dark theme when the
> tokens define one. A token sheet shows only its dark pane, and a component
> specimen renders on dark document roots. A one-off migration made the IQ
> Industries files (fraxnet, fraxramp, tupredices) dark-only at the owner's
> request and re-rendered every preview in them.

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
| Browser tabs in a turn | 4, each in a browser context of its own, rendering one sprite at a time |
| Nodes per batch / per sprite | 96 / 24 |
| Edit debounce | None for the first edit after 1.2 quiet seconds; 1.2 seconds within a burst |
| Warm browser between turns | Only when another turn is due at once; reused within 3 seconds, then closed. Browser Run's own idle limit is 60 seconds, in case that close fails |
| Fair turn / sprite deadline / hard session deadline | 8 / 20 / 40 seconds; the turn is 15 seconds when no other file can run |
| Reserved time before admission | 60 seconds, refunded to measured elapsed time |
| Daily automatic browser time per file, per workspace, globally and for `BACKFILL` files | Lifted on 4 Nov 2026: about 11.5 days each, so never reached. Spend is still recorded. Earlier values were 30 minutes, 1 hour, 4 hours and 1 hour. |
| Queued files | 1,000 |
| Attempts per node revision | 3 |

The shared Durable Object rotates workspaces, then files. Files in the temporary
`BACKFILL` set wait behind every file someone is viewing. A busy file keeps one
browser session across its batches until its fair turn expires; it does not
launch another browser per batch. Idle browser time is billed like any other, so
a healthy turn leaves its browser running only when another turn is due at once:
its file still has previews to render (a bulk edit that outlasts its fair turn, or
the next edit of a burst after its debounce), or another file is waiting. The
queue hands that session to the next automatic turn, of any file, within 3
seconds, and otherwise closes it. Every other turn closes its browser, as does a
turn with a failed sprite, a failed single render or a timed-out session. Only a
session Sharpner left is reused, never another idle session on the account.
`thumbnail-turn` logs `timing`: `prep` before the browser, `open` for the tabs,
`store` for R2 and the FileRoom, and `release`.

### Warm browser, production, 7–8 Nov 2026

From #53 until this rule, every healthy turn left its browser running for 60
seconds. Workers Logs for the 680 turns from 7 Nov 10:27 to 8 Nov 01:24 UTC
(`thumbnail-turn`, 99.5% of lines retrieved) give about 3.7 hours of idle browser
between and after turns, estimated as the gap from one turn's end to the next
turn's start, capped at 60 seconds, against 1.65 hours of turn time. Reconnecting
took a median 0.58 seconds and launching 1.56 seconds, so reuse saved about 0.2
hours of launches. Daily browser time from the same logs matched the bill: about
4.9 hours on 7 Nov (billed about 5), when rendering alone was 1.5 hours. Replaying
those gaps, closing after every turn costs 0.19 hours of launches, keeping the
browser 3 seconds only when its file had previews left costs 0.21 hours, and 10
seconds after every turn costs 1.29 hours. A single-preview turn took a median
3.3 seconds: 0.58 to launch or reconnect, 0.46 sending 412 KB of documents and
fonts, 0.92 loading, capturing and encoding, and 1.05 outside the logged phases,
which `timing` now splits.
Persistent leases and conservative reservations protect admission across
restarts and failures. Explicit `screenshot_nodes` requests use the same browser
slot and the file's serialized browser work, with bounded waiting and session
time. Their usage is logged separately and is outside automatic daily quotas.

Each node keeps exactly one preview. Every file renders its pending previews whether or not anyone has it open, so previews follow agent edits; viewed pages render before other pages.
Per-edit browser time is one render per edited node, regardless of how many
themes the tokens declare.

No automatic browser launches for a file without an active, unexpired viewing
socket. Explicitly selecting an uncached cover is an exception: only its current
pair renders, through the same budget, and the request clears when it lands.
A new page presence resumes a file's other pending work. Rapid changes are coalesced;
revision checks reject raced renders. A design-system edit does not end a session:
it bumps the revision of every node it affects, so their in-flight renders are dropped,
and later batches render against the new design. Unique
attempt URLs prevent late uploads from overwriting or deleting a retry. The
selected fallback remains owned until its replacement lands. Background renders
never change active heights. The existing live/thumbnail handoffs remain in use.

Admission requires room for the entire reservation, so a nearly exhausted budget
can defer work before the numeric limit is reached. At a budget limit, new previews wait until the next UTC day; cached switches and
live frames still work. Missing `THUMBNAIL_QUEUE` configuration disables automatic
work instead of bypassing the budget. Each denied admission logs `thumbnail-deferred` with
the files and the budgets they exhausted; each turn logs `thumbnail-turn` with its rendered
count, browser time, launch time and turn length. Add the binding and `v2` Durable Object
migration from `wrangler.example.jsonc` when deploying.

Until 2026-11-02 the limits were 90 seconds per file, 180 seconds per workspace and
900 seconds globally, and the backfill shared the global budget. Production logs that
day showed every automatic turn for a viewed file refused at admission: the canvas
showed "Rendering…" and live frames only, and nothing appeared once zoomed out.
The raised global cap allows at most 120 browser-hours in a 30-day month: about
$10/month above the 10 included hours at $0.09/hour if it is used up every day,
with the single shared browser keeping concurrency within the included allowance. Raise it using
observed queue delay and per-team demand; the cost estimates below assume the
requested work is admitted, rather than treating deferred work as free capacity.
At the measured throughput, 1,000 teams with the modeled workload need about
216 automatic browser-hours/month, still below one continuously occupied browser.

With the daily budgets lifted, the single automatic browser is the only limit: at most 720
browser-hours in a 30-day month, about $64/month above the included hours if it never stops.

## Sprites

Frames, components and token sheets render in sprites. A sprite is one browser page
holding up to 24 nodes, each in its own same-origin `srcdoc` iframe at its own width,
so viewport units, media queries, fixed positioning, root styles, custom element
definitions and authored scripts resolve as they do in a page of their own. The page
loads every document at once, compiles Tailwind once per distinct stylesheet, shares
the prepared fonts through blob URLs, fits each auto-height frame to its content, and
packs the frames into one layout. Lossless captures of bands of rows, at most 4 million
pixels each, cover the sprite; the page then crops each node and encodes its WebP tiers.
Canvas WebP at 0.8 is the same encoder and setting as a WebP capture at quality 80. A
band travels to the Worker and back as base64 PNG, so its size bounds Worker memory
for photographic content and keeps it inside one WebSocket message; a node larger than a
band is captured directly as WebP. Frames wider than 1280px form sprites of
their own width, captured at the sharp tier's scale. `worker/render-sprite.ts` holds
the renderer and its limits.

Each tab opens in a browser context of its own. Puppeteer serializes screenshots per
context and brings the capturing tab to the front, so tabs sharing a context take turns
capturing; in their own contexts they capture in parallel. Locally this halved the
summed capture time for 40 screens (4.2 to 2.2 seconds). A turn falls back to the
shared context when contexts are unavailable, and closes its contexts when it ends.
A raw CDP capture that skips the lock does not work: a tab that is not in front
produces no frames, and the capture times out.

A production A/B on 7 Nov 2026 rotated one test file's turns through shared or own
contexts with four or two tabs (14 previews per turn, 2 or 3 turns per layout). Medians
were 9.5 s (own contexts, four tabs), 9.9 s (shared, four), 10.1 s (own, two) and
10.5 s (shared, two), with overlapping ranges: no measurable difference during a period
when every turn took about twice as long as an hour earlier. Four tabs did about
70% more summed browser work than two for the same wall time, so the production
browser was bound by its own CPU rather than by capture order. Own contexts with four
tabs stayed the default.

A sprite sends only the font subsets its documents' characters need. Google splits
each weight into `unicode-range` subsets, and the Inter sheet in the measurement
fixture is 1.1 MB in 28 faces, nearly all for scripts the documents never use. A
browser only downloads subsets its text needs, so the result is the same. Text an
authored script writes need not be in its source, so a sprite whose screens or
components contain a script sends every subset. On 7 Nov 2026 production turns
spent about 70% of a sprite's load sending its 1.2 MB, against 30% in the page.

A node renders alone, through the single-page path, when its content keeps growing
with its frame, when it is still loading after 8 seconds, when it does not fit the
sprite page, or when its sprite failed. The FileRoom keeps those revisions in the
`thumbSolo` meta key. A failed sprite charges no retry and retires only its tab.
`thumbnail-turn` logs `pending`, the previews still trailing their node's revision
after the turn, with sprite counts, `launchMs`, whether the browser was `reused` and
left `warm`, and time per phase: `seed` (the Worker's first Tailwind pass and the
documents), `load`, `settle`, `capture` and `encode`, summed over the turn's tabs, with
`pageLoad`, the part of `load` the page itself spent, and `sentKB`, the documents and
fonts sent to it. In Workers `Date.now()` advances only across I/O, so CPU-only work
such as `seed` lands in the next phase that waits on the browser.

### Measurements, 2026-11-07

Local Browser Run (Chrome 126.0.6478.182, headless), four tabs, on the Forge desktop
(10 threads). Fixture: a token sheet with Inter from Google Fonts, 40 component
specimens and 40 screens (1280×1000 and 1280×900 dashboards and settings, 390px
auto-height lists, 1440px auto-height landing pages) built from those components. Not
production or invoice measurements.

| Renderer only, warm compilers | Single pages | Sprites |
| --- | ---: | ---: |
| 40 component specimens, median of 5 alternating runs | 2.58 s (2.54–2.66) | 0.38 s (0.37–0.40) |
| 40 screens, median of 5 | 4.40 s (4.35–4.54) | 2.10 s (2.06–2.25) |
| Worker-side CPU (Node process time), specimens / screens | 0.56 / 0.72 s | 0.12 / 0.41 s |

| Live app (`verify-sharpner`), MCP edit to `pending: 0` | `main` 67b2feb | Sprites |
| --- | ---: | ---: |
| Edit `Button/Primary`, 42 previews, median of 5 | 6.07 s (5.97–6.12) | 3.61 s (3.46–3.76) |
| Edit the token sheet, all 81 previews, median of 4 | 8.65 s (8.48–8.73) | 4.39 s (4.36–4.47) |
| Browser time for the token edit, median | 7.46 s | 3.19 s |

Both live paths include the 1.2-second debounce and ran in one turn with no failed
render. Single-page captures were the limiter: Puppeteer serializes screenshots across
a browser context and brings each tab to the front, about 150 ms per capture with four
tabs against 40 ms with one. Sprites take one capture per sprite.

### Production, 7 Nov 2026

Sharpner production, one test file of a token sheet, 16 components and 12 screens (9 at
1280px and 390px, 3 auto-height at 1440px). Times run from the end of the MCP edit's
FileRoom apply to the end of the turn that left `pending: 0`, from `wrangler tail`. One
or two runs per release, so these show the direction rather than settle a number;
production runs vary by about a third. The single-page path was not measured in
production before sprites shipped.

| Release | `Button/Primary`, 14 previews | Token sheet, 29 previews | Launch or reconnect |
| --- | ---: | ---: | ---: |
| Sprites (#52) | 5.7, 7.7 s | 15.2 s | 1.0–2.3 s |
| First edit at once, warm browser (#53) | 5.2, 5.4 s warm; 7.5 s cold | 8.8 s | 74–106 ms warm |
| Font subsets (#55) | 6.2 s warm; 7.9 s cold | | 0.6 s warm |
| Own context per tab (#56) | 5.6 s warm; 6.8 s cold | | 79 ms warm |

Font pruning cut what a turn sends from 4.9 MB to 1.3 MB and its summed load time from
5.5–5.9 s to 3.2–3.5 s; before it, 70% of load was transfer. The Worker spends only
130–350 ms of CPU per turn, so turns are bound by the browser and the transfer to it.
Half an hour later every turn took about 10 seconds whatever its layout; see the A/B
above.

Fidelity: eleven edge-case documents (viewport units, a fixed bar, a script, an
overflowing fixed-height frame, root `rem`, a media query, a CSS background image, a
dark `color-scheme` root, a viewport-high hero, and 1440px fixed and auto frames)
produced byte-identical WebP tiers and heights in both paths; two of them rendered
alone as designed. Across the 80 fixture nodes, lossless captures differ in 0.004% of
screen pixels and 0.014% of specimen pixels, by at most 4/255 except one
antialiased edge pixel at 40/255, from antialiasing of curves at a different page
offset. Sizes and measured heights match exactly, so existing previews were not
re-rendered.

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
