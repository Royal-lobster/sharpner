# A canvas that adapts to changes

> 2026-11-02: theme switching was removed. Screens render exactly their authored
> HTML, so the live-iframe theme hot-swap and the "theme change" measurements
> below are historical experiments, not current behavior.

The interactive representation should be HTML that can change locally. A raster
is a useful loading and navigation cache, but cannot respond to a new font,
component tree or layout until something renders those changes. Keep the fast
raster opening path; stop treating server screenshots as the only way to show
interactive changes.

## Experiments, 2026-11-01

Three parallel prototypes ran on the existing signed-in editor route, alongside
the existing raster painter and fresh sandboxed HTML documents. All HTML paths
used `frameDocument`, the same Tailwind 4.3.3 compiled CSS, prepared Inter fonts,
real file sources and Light/Dark tokens. The persistent experiment retained an
opaque sandboxed iframe and changed its document without navigation. The Shadow
DOM experiment shared stylesheets and translated document CSS. The capture
experiment serialized HTML into SVG `foreignObject`, decoded it into a readable
canvas and then removed its temporary iframe.

These are local production-build experiments on the Forge desktop, Chrome 156,
1280×800. They are feasibility measurements, not production SLOs or mobile-device
benchmarks. Forty distinct 1200×1000 analytics screens were used; the 200/300
cases clone those forty inputs to stress resident surface density. Raster clones
also reuse forty image URLs. Sources, fonts and HTTP caches were warm; stylesheet
preparation and authentication are outside the surface timings below. No
server browser was launched by any of the client experiments.

| Renderer, 40 screens | Prepare surfaces | Theme change | Source edit | Resident iframes |
| --- | ---: | ---: | ---: | ---: |
| Cached raster | 65 ms | 11–32 ms, cached pairs only | Needs a new render | 0 |
| Fresh HTML document per update | 1,336 ms | 1,341–1,360 ms | 1,425 ms | 40 |
| Persistent sandboxed HTML | 558 ms | 51–55 ms | 112 ms | 40 |
| Shadow DOM | 114 ms | 10–29 ms | 34 ms | 0 |
| HTML → SVG → canvas capture | 4,973 ms | 4,579–4,756 ms | 4,568 ms | 0 after capture |
| SVG capture, unused font faces pruned | 2,420 ms | 2,393–2,571 ms | 2,413 ms | 0 after capture |

The raster source-edit attempt is deliberately recorded as unsupported, rather
than counting its quick return as successful rendering. Its cached repeat switch
remains the fastest path. A genuinely new presentation needs HTML rendering.

| Density | Persistent: prepare / theme / source | Shadow DOM: prepare / theme / source | Fresh HTML: theme |
| --- | --- | --- | --- |
| 200 simple screens | 3,421 / 285–309 / 508 ms | 352 / 51 / 185 ms | 7,720–7,923 ms |
| 300 simple screens | 6,036 / 437–485 / 1,076 ms | 507 / 72–83 / 251 ms | 13,547–14,527 ms |
| 40 dense screens, about 54,000 DOM nodes | 1,079 / 293–294 / 540 ms | 514 / 101–104 / 428 ms | 2,027–2,034 ms |

A one-second transform/pan probe had p95 animation intervals of about 16.8 ms
across these cases. This short, headless transform probe does not establish
device GPU performance, sustained interaction or low-end mobile suitability.
`performance.memory` returned a constant coarse value and was unusable for
comparison. Process RSS grew into gigabytes during the matrix, with substantial
carry-over between navigations; it cannot be attributed precisely to an individual
renderer. Hundreds of resident iframe documents are not justified by these data.

### Fidelity and exclusions

Single-screen crops compared Light, Dark, As authored and restoration to Light
for the real analytics screen, a structural component override with a different
font, and a document fixture with nested contexts, root `rem`, viewport units,
responsive CSS, pseudo-elements, relative images and inline SVG.

Persistent HTML matched the fresh-document reference in all twelve crops:
**zero different pixels per 580×483 crop**. Shadow DOM matched the simple and
structural fixtures but differed on root font sizing in the document fixture;
it also reported an unsupported feature. Shadow DOM is not a security sandbox,
and the prototype sanitizer is not a production security guarantee. Its CSS and
global font namespace differences prevent replacing arbitrary Sharpner HTML.

SVG captures were readable and visually plausible for these fixtures, but
resampling changed pixels and capture took seconds per page. Cross-origin
resource readback, unsupported CSS and authored script behavior need explicit
fallback. Making capture the interactive path would move latency and CPU to the
member's device. Any useful capture path should run after an immediate HTML
update, while idle, and be cancellable.

Pruning only font faces whose matching browser `FontFace` entries remained
unloaded removed about 979 KB per serialized screen (1.22 MB → 236 KB) and
roughly halved capture latency. Analytics captures were pixel-identical to the
unpruned SVG output. First-wave per-screen instrumentation attributed about
160–203 ms to source document preparation, 6–7 ms to serialization and 37–74 ms
to SVG decode under four-way capture concurrency. Reusing already-live source
documents would avoid some of that work, but was not implemented or measured.

The persistent prototype manually expanded components and deliberately rejected
executable authored behavior. It is evidence for the rendering approach, not
production runtime code. Shared component semantics must remain in
`frameDocument`; do not maintain a second component engine.

## What is safe to ship now

The production change keeps the existing overview admission limits and raster
first paint. (Historical: this shipped a warm theme update for already-live documents; it was
removed with theme switching.) Content/design edits and cold assets use the
fresh-document swap. Only the latest request may report
readiness or height. This improves the shared runtime without committing to an
unbounded overview DOM or trusting a capture library.

In the running production editor, a focused frame retained the same iframe
through five Light/Dark/As-authored choices, acknowledging changes in 25–59 ms.
The final build recheck acknowledged a warm change in 42 ms. A source edit with
an authored script executed inside its sandbox and used the replacement path;
none of twelve sampled animation frames had an empty live backdrop. Repeated
overview switches were also rechecked at 1280×800 and 390×844: all forty matching
cached rasters painted, with zero dimmed draws and no live iframes. These checks
exercise the actual editor; playback input remains disabled.

It does **not** make every uncached overview frame live. The current planner
admits up to six current and twelve outdated previews, and excludes very small
frames. A bounded pool cannot update all 300 simultaneously visible dirty frames
and then evict them: without a matching bitmap, eviction reveals stale pixels.

## Recommended next architecture

1. Preserve cached rasters for immediate opening, dense navigation and inactive
   content. Make HTML surfaces the local interactive representation for a
   bounded active set. Prioritize selection, recent edits and substantial visible
   area; stop admission during navigation, hidden tabs and constrained-device
   conditions.
2. Compile CSS once per actual design-system/CSS generation, sharing it with live
   frames. Track source candidates and expanded dynamic classes correctly, and
   retain fallback for authored behavior. Do not put a Tailwind compiler in every
   screen. The server path already does this; the experiment's local-only CSS
   endpoint is not an authenticated production capability.
3. Share a persistent runtime with the ordinary document path, including
   structural component updates and authored-context restoration. Bound source
   bytes, DOM complexity, active surfaces and activation work—not just iframe
   count. Validate actual low-end devices and separately measure browser native
   memory and sustained frame time.
4. Add a faithful local bitmap path only when available. Keep new live pixels
   resident until their exact content bitmap exists. With a small pool,
   progressively process larger dirty overviews; do not promise simultaneous
   instant changes beyond its budget. Deduplicate uploads and checkpoint only
   useful snapshots instead of persisting every intermediate edit.
5. Keep explicit agent screenshots and authoritative covers on the bounded
   server path. Their fidelity and availability do not depend on an editor being
   open. Keep fair shared fallback scheduling and existing browser quotas.

This is a larger architecture change and should land in stages with these gates,
rather than shipping the experiment as a second renderer.

### Interaction playback uses the same rendering model

Interaction experiments should remain ordinary frames/components beside the
screens they belong to. A saved eligibility property and a viewer-local Interact
action are separate concerns. Future playback should activate one isolated
runtime for mouse, keyboard, touch and scroll input, with outer Stop and Reset
controls. Its temporary input/animation state belongs to that viewer, not the
shared document or the canonical thumbnail identity.

This strengthens the case for retaining real browser HTML and JavaScript rather
than translating everything into a limited drawing scene. It also argues against
running hundreds of scripted documents at overview zoom. Inactive interactive
designs need a chosen poster state and disposal of their executable runtime;
pausing CSS animations alone does not stop authored JavaScript timers. Reset
recreates the initial document. Preserving playback state across source
changes needs an explicit runtime contract; authored scripts keep their existing
reload semantics.

[Interaction playback](interaction-playback.md) now supplies viewer-local
Interact/Stop/Reset controls and one disposable sandboxed document. Normal canvas
previews keep pointer input disabled. Dedicated preview origin and stronger
resource isolation remain hardening work. Live playback, covers and explicitly
requested agent screenshots use the same document renderer.

The [interaction-first experiments](interaction-first-experiments.md) test
automatic motion, user-triggered flows and deterministic local scenarios. Four
dense runtimes retained 16.7 ms p95 frame intervals in a 30-second desktop probe,
while forty degraded badly. The [overview convergence](unseen-overview-convergence.md)
and [instant variant documents](instant-variant-documents.md) reports measure
bounded native documents, shared CSS and server atlases against the three-second
target for an uncached theme switch.

### Native HTML in canvas

Chrome's [HTML-in-Canvas announcement](https://developer.chrome.com/blog/html-in-canvas)
targets Chrome 157. `drawElementImage()` and a `paint` event with changed elements
could retain browser HTML/CSS fidelity while updating only changed surfaces.
The actual Chrome 156 preview here exposes none of the relevant unflagged APIs.
It is a future capability, not a dependency for current Sharpner.

The [proposal](https://github.com/WICG/html-in-canvas) also excludes cross-origin
iframe content and some external assets from readback. An implementation inside
the opaque sandbox with bitmap transfer is worth testing when supported; putting
today's iframes below a parent canvas does not bypass those restrictions.

### What Figma does differently

Figma owns its document representation and a
[C++/Wasm renderer using WebGPU with a WebGL fallback](https://www.figma.com/blog/figma-rendering-powered-by-webgpu/).
It can update scene properties without reconstructing arbitrary browser pages.
Its [React code layers](https://www.figma.com/blog/building-figmas-code-layers/)
remain a separate sandboxed code primitive, with compilation in a worker.
These sources do not establish an automatic HTML-to-native-scene conversion.

[CanvasKit](https://docs.skia.org/docs/user/modules/canvaskit/) supplies drawing
and text shaping, not HTML/CSS layout. A native scene format could be very fast,
but supporting Sharpner's existing HTML would require reproducing layout,
stacking, fonts, clipping, pseudo-elements and CSS behavior. That would change
the authoring contract. Color-filtering rasters likewise cannot implement font,
layout or component structure changes correctly.

## Cost implications

The [server cost model](thumbnail-rendering.md#cost-comparison-and-recommendation)
still applies: roughly **$0.44–0.47 → $0.10 per active team/month**, with the
stated workload, including R2, browser lifetime and estimated Worker CPU. Its
automatic browser demand falls from about 1.73 to 0.217 hours/team/month; explicit
screenshots add about 0.042 hours after optimization. These are planning estimates
before account-wide included usage, not invoice measurements.

Every client experiment's local update costs **zero Browser Run seconds** and
zero R2 operations until something is uploaded. It still consumes client CPU,
memory and battery. The narrow production fast path leaves server checkpoint
policy unchanged, so it does not claim further monthly savings.

A future persistent/capture hybrid could remove the remaining 0.217 automatic
browser-hours (about $0.020/team/month). Uploading every client result as the
same two objects retains about $0.054/month of PUT costs and most of the remaining
bill. For the modeled 6,000 generated pairs/month, a hypothetical fourfold
checkpoint reduction plus one overview object would reduce 12,000 PUTs to 1,500
(about $0.0068); adding 300 explicit screenshot screens, cached GETs, storage and
rough CPU allowances gives a planning range around **$0.02–0.04/team/month**.
That is a scenario, not a measured result: capture eligibility, checkpoint
freshness, cover/sharp-preview requests and fallback rates determine actual cost.
Do not trade fidelity or cold-load speed for a claimed zero bill.

## Reproduction and evidence

The throwaway [experiment/live-canvas-rendering branch](https://github.com/Royal-lobster/sharpner/tree/experiment/live-canvas-rendering)
(head `b50bda9`) preserves the experiment
route, renderers and local CSS preparation. Build with
`VITE_RENDER_EXPERIMENT=1 pnpm build`, then run
`devcap pnpm preview --port 5200 --strictPort`. In an authenticated existing file,
append `?prototype=render&variant=persistent&count=40`; variants are `raster`,
`fresh`, `persistent`, `shadow` and `svg`. `case=variants|fidelity|dense` exercises
the additional fixtures. It modifies fixture state in memory, not shared file
sources. The route is local-only and is absent from the implementation branch.

Raw samples, pixel comparisons and actual-editor screenshots are outside git:
`~/.cache/agent-artifacts/sharpner/2026-11-01/035724-live-canvas-experiments-1abcb6/`.
