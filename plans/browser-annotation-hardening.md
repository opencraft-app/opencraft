# Browser annotation hardening (1–4)

## Scope and UI ownership

The user requested screenshot privacy, live target tracking, asynchronous image
encoding, and overlay lifecycle isolation. Disk management is excluded.
The existing annotation editor remains the composition owner: add-comment is
primary; preview-target-image and remove-image are secondary shared Buttons.
The editor owns bounded scrolling within the browser slot/visual viewport;
mobile uses the existing sheet, desktop the existing card, both theme tokens.

## Implemented

- Comments are text-only unless the user requests a target-region preview.
  Only that reviewed crop enters composer metadata. Removing the image, changing
  selection, cancelling or changing drafts discards pending previews. No implicit
  capture on submit and no fallback to full-viewport attachments.
- Crop geometry is checked before/after capture and rounded inward. Sensitive
  targets fail closed. The user sees a privacy reminder and can remove the image.
  This is not universal pixel redaction: overlapping private content or a large
  selected container can still appear in a crop and needs user review.
- Image decode/crop/JPEG encoding uses a short-lived Worker and OffscreenCanvas.
  The compatibility path uses asynchronous canvas.toBlob, never toDataURL.
  The Worker is terminated on completion/error/abort/timeout. Both dimensions
  and encoded attachment size are bounded. Full viewport capture still happens
  in the surface host; it is not sent to the Agent as the annotation attachment.
- Elements receive document-scoped binding keys, stable across repicks. The
  overlay holds weak references and never rebinds a key to a replacement node.
  Missing/expired targets hide instead of showing stale coordinates. Nested
  scroll, clipping, sticky positioning and layout shifts follow current geometry.
- One shared overlay implementation serves remote preload and HTML/desktop
  injected agents. It owns its actual host reference, never adopts or removes
  page nodes based on a matching ID. No MutationObserver. A bounded geometry
  RAF exists only while marks have live targets and the document is visible; remote Hands parking explicitly suspends it even
  when Electron reports a visible document;
  no style writes if geometry is unchanged. Disposal/empty marks stop work.
- Remote annotation preload must now be bundled by the official runtime packager,
  not copied as standalone source. The smoke runtime follows the same rule.

## Verification and limits

- Unit tests cover crop bounds, invalid geometry and binding identity replacement.
- Tracking browser smoke covers nested scroll, clipping, layout, sticky, replaced
  targets, colliding host IDs, zero idle frames and disposal.
- Screenshot browser smoke verifies real Worker and async fallback output pixels,
  excludes the red outside-target region, and checks Worker termination/abort.
- Actual React hook/Composer smoke covers text-only submit, preview, remove,
  attachment of reviewed crop and cancellation after switching drafts.
- HTML sandbox and real offscreen Electron overlay smoke retained.
- Shared editor light/dark desktop/touch presentations inspected in a synthetic
  component harness. Not a physical-phone or live authenticated Shell test.
- Arbitrary CSS transforms on document roots and rapidly changing captured pages
  are not an atomic DOM/frame snapshot guarantee. Before/after geometry checks
  plus explicit user preview mitigate but do not eliminate that limitation.
- Existing coordinate-only low-level overlay calls remain compatible; new UI
  marks always require a bound identity. Old persisted annotations without one
  retain text but do not recreate potentially incorrect page markers.

This follow-up is a source change, not a deployment receipt.
