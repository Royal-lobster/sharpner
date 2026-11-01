# Interaction playback

Interaction studies are ordinary frames and components beside the designs they
belong to. A member enables **Interaction options → Enable interaction** on a
selected design, or an agent sets `interactive: true` through `create_nodes` or
`update_nodes`. Viewers choose **Interact** to play it in place. Shared-link
viewers can play enabled designs and cannot change their eligibility.

The saved boolean is a capability, independent of content identity. Room migration
10 adds it with a false default and survives migration replay. Only frames and
components may enable it. Changing the flag preserves content revisions, source,
theme previews, covers and library dependents. Existing nodes keep their previous
ordinary preview behavior until enabled.

## Lifecycle and cost

- Each editor admits one playback document. Enabled inactive designs show their
  existing posters. While playing, ordinary live HTML previews are suspended too;
  navigation and images retain their existing budgets.
- Playback pins that one document even when panning away, so navigation does not
  discard its local state. Changing designs disposes the old document. Hiding the
  tab, changing pages, losing the connection, deleting/disabling the node, or
  leaving its selection in an editable file ends playback.
- Reset recreates the initial document. Stop or Escape disposes it and returns
  keyboard focus to the canvas. The outer controls remain outside authored HTML.
  Escape is reserved for leaving playback.
- Source, size, design-system and theme changes recreate the document rather than
  attempting to migrate arbitrary JavaScript state. Stale document messages are
  rejected by iframe window and per-document token.
- Clicked states, typed input and animation state never enter Room operations,
  canonical geometry or thumbnails. The iframe keeps the design's viewport;
  scrolling and transient height changes stay inside it. In particular it has
  no legacy `data-id` height-reporting channel.
- Startup gates input until the exact document acknowledges readiness. Fonts wait
  at most two seconds, with the existing 120 ms style allowance. A document that
  does not become ready within twelve seconds is disposed with a retry message.

Playback itself launches no server browser and writes no R2 objects. It uses the
member's browser and fetches one design's sources plus the existing design system.
Enabling the flag also enqueues no render. Initial posters, later content edits,
covers and explicit agent screenshots retain the bounded server path described
in [thumbnail rendering](thumbnail-rendering.md). The browser Tailwind compiler
still initializes once in the requested playback document; sharing compiled CSS
with live documents remains a separate performance improvement.

## Document rendering and isolation

`interactionDocument` wraps the actual `frameDocument` output. It introduces a
trusted asset base, policy and small input/navigation bridge before authored
bytes, including malformed full documents. The initial doctype preserves
standards mode, and authored root/body attributes remain available. Components,
tokens and effective themes use the same renderer as previews and screenshots.

The iframe has an opaque origin. Its sandbox allows scripts and local form
events; it does not allow same-origin access, popups, top navigation, downloads
or modal dialogs. Camera, microphone, geolocation, screen capture and clipboard
permissions are denied. The bridge validates messages by current window and
random token; arbitrary window messages cannot change the shared document.

A playback-only CSP blocks API connections, network form submissions, workers,
media and embedded resource frames/objects. It permits inline authored JavaScript,
the pinned Tailwind browser bundle, and styles/fonts/images from HTTPS or the
app's asset origin. No eval or arbitrary external JavaScript packages are enabled.
Local submit handlers and browser form validation run normally; handlers should
cancel submission when simulating a product flow. `form-action 'none'` blocks an
uncancelled submission. Ordinary anchors keep their authored handlers but cannot
navigate; local fragment links scroll within the design. Navigation attempts
request disposal rather than loading another playable document.

This is not complete network or CPU isolation. Display-resource URLs remain
network-capable, initial script self-navigation can issue a request before
disposal, and APIs outside CSP's connection model need separate controls.
Arbitrary JavaScript can also monopolize its renderer thread; a sandbox is not
a CPU quota. A dedicated preview origin and an explicit asset/dependency policy
remain hardening work before treating hostile third-party code as supported.
Normal previews and server screenshots retain their existing policies; playback
restrictions are deliberately not applied to every existing file's renderer.
See the [HTML sandbox standard](https://html.spec.whatwg.org/multipage/iframe-embed-object.html#attr-iframe-sandbox)
and [CSP form-action rules](https://www.w3.org/TR/CSP3/#directive-form-action).

## Verification

Tests cover saved capability migration/replay, round trips and validation,
unchanged content/preview/library identity, MCP/client metadata, poster/live
admission, pinned single playback, policy placement, scoped replies, readiness,
input gating and navigation handling. Runtime checks use the actual editor and
synthetic designs with inputs, click state, pointer drag, scrolling, local forms
and browser animations. Verification media stays outside source control.

The larger [live canvas architecture](live-canvas-rendering.md) still needs a
bounded overview hydration policy and a faithful local bitmap handoff. Selective
playback provides an explicit, small active set without changing fast raster
opening or promising that all 300 overview frames become live.

The [interaction-first experiments](interaction-first-experiments.md) recommend
making motion and behavior part of ordinary screen authoring, with execution
controlled by the render planner. The current flag is a compatibility/rollout
gate. Named scenarios, cooperative state restoration and bounded automatic motion
are measured next steps; they are not implemented by this playback capability.
