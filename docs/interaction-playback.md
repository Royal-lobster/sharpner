# Interaction playback

Any frame or component can be played in place. Members select it and choose
**Interact** in the selection toolbar; shared-link viewers, who cannot select,
use the **Interact** button on the design. Nothing is saved: there is no flag,
no schema change and no room operation. Interaction studies are ordinary frames
and components beside the designs they belong to.

Live previews already run authored scripts in an opaque sandbox. Playback adds
input to one of them under a stricter policy, so there is no separate opt-in.

## Lifecycle and cost

- Each editor admits one playback document, added on top of the normal live
  budget. Other live previews, posters and images keep rendering as usual. The
  camera does not move; zoom in first if the design is small on screen.
- Playback pins that one document even when panning away, so navigation does not
  discard its local state. Changing designs disposes the old document. Hiding the
  tab, changing pages, losing the connection, deleting the node, entering comment mode, or
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
Initial posters, later content edits,
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

Tests cover live admission alongside other previews, pinned single playback,
policy placement, scoped replies, readiness, input gating and navigation
handling. Runtime checks use the actual editor and
synthetic designs with inputs, click state, pointer drag, scrolling, local forms
and browser animations. Verification media stays outside source control.

The larger [live canvas architecture](live-canvas-rendering.md) still needs a
bounded overview hydration policy and a faithful local bitmap handoff. Selective
playback provides an explicit, small active set without changing fast raster
opening or promising that all 300 overview frames become live.

Named scenarios, cooperative state restoration and bounded automatic motion are
possible next steps; they are not implemented by playback.
