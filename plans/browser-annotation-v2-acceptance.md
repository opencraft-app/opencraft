# Browser annotation V2 implementation and acceptance

## Implemented
- Bounded V2 selections, stable labels, atomic Composer edits, old draft restoration, 8 comments / 32 targets / 8 images per draft. Storage is checked in UTF-8 before mutation.
- Element/region/text modes, multi-target comments, exact replacement text (including empty deletion), allowlisted computed-style requests, per-image review and target/context associations.
- Real provider input contains ordered image-preface/image pairs and separates user intent from untrusted page evidence; no invented child-frame tool refs. Display URLs redact credentials/query/fragment.
- Page-hosted overlays in owned opaque HTML previews, guest webviews and remote Electron pages; same-origin frames and open shadow roots, generation-bound snapshots, cancellation and navigation fences.
- Controlled HTML preview supports temporary styles/simple text, original-view comparison and conflict-safe restoration. External/remote pages do not receive mutation permission by default. No source-file write occurs.
- Passive semantic context: opt-in `data-oc-annotation-name` and bounded JSON scalar `data-oc-annotation-metadata`; no page callback execution or automatic user comment/send.
- Mobile selection modes separate dragging from native scrolling; editor uses the shared theme/control system. Saved comments can be reopened and replaced without losing target identities. Restored targets are historical evidence, not renewed authority.
- Compiler demand-loading keeps new validation off the cold-open path. Build gate retains existing byte limits and enforces lazy annotation controls/compiler.

## Executed checks
- Browser protocol/DOM/frame/transport/sink suites; minified toString injection in Chromium, actual opaque iframe postMessage, guest console navigation and touch cancellation.
- Real integrated React layer + shared styles + opaque HTML iframe: desktop and mobile-sized Chromium, two-target comments, preview/original, atomic saved edit, region, reload preservation.
- Generic compiler/command-port/model capability suites and remote WebSocket service identity/control tests.
- Electron offscreen/preload smoke: overlay pixel capture, scrolling/zoom, revision isolation, screenshot inclusion, cleanup/navigation (20 assertions).
- Workbench typecheck and production product Web build with unchanged startup budgets. Measured development-base startup: JS 3,515,020 bytes; CSS 708,198; gzip 1,197,439. These are build bytes, not runtime performance claims.

## Explicit limits / follow-up acceptance
- Cross-origin/inaccessible and transformed/zoomed child frames fail explicitly. No sandbox permission relaxation.
- Text/region markers are generation-bound snapshot rectangles, not live multi-line Range/reflow tracking. Old snapshot generations cannot be adopted merely by drawing a saved marker.
- Complex rich-text replacement preview is refused rather than destroying nested DOM. Text intent can still be sent as evidence.
- Video-frame identity between a phone's displayed remote frame and later server hit-testing is not proven. Server confirmation is current-document selection, not a historical-frame guarantee.
- Mobile Chromium emulation/touch automation passed; physical iOS keyboard/rotation, real high-latency WAN and long-running CPU/power measurement remain untested.
- No active page request-to-open/provider callbacks, Office/Docs-specific adapters or automatic source mapping. Passive metadata is evidence only.
- Integration into source does not deploy a running service; release requires a separately identified candidate and cutover checks.
