# Upload image processing

Independent Cordis `imageProcessing` service. Owns CPU admission (one active
job, at most 16 waiting), cancellation and disposal. No Hermes, filesystem,
AppServer, React, object-URL or Blob-cache ownership. Browser codec is injected.

`compress(blob, { signal, onProgress })` returns a Blob plus changed/reason.
Stages are queued/inspecting/decoding/encoding, not invented percentages.
Original File is never mutated. An output at least as large as its input is
discarded for ordinary compression, but a successful HEIC/HEIF-to-JPEG
compatibility transcode is retained because the original format cannot be sent
through the inline image contract. Cache is not involved: this processes private local upload data.

Browser path runs in a module Worker. Cancelling an active operation terminates
that Worker (including synchronous WASM); cancellation never silently uploads
the original. Disposal aborts all work. Codec failures/timeouts (20s) preserve
the original. Invalid safety budgets reject rather than decode.

Policies:
- JPEG: orientation-aware browser decode, max edge 2560, no upscale, quality
  0.88, original JPEG format. Re-encoding may remove metadata and convert color
  space; these are upload derivatives, not archival originals.
- PNG: lazy single-thread OxiPNG WASM level 2; original dimensions and alpha,
  no palette quantisation, no lossy conversion, no transparent-pixel rewriting.
- HEIC/HEIF: a selected browser File uses the main-thread image element and
  canvas JPEG encoder, matching the browser path that can display its preview.
  Up to 50 MP is admitted one image at a time for current camera modes; the
  derivative is scaled to a 2560px maximum edge and may lose original
  metadata, color profile or Live Photo features. If this browser cannot decode
  or encode it, attachment resolution fails with an actionable retry error;
  the original HEIC is never mislabeled as JPEG.
- APNG, GIF, WebP, SVG and other unsupported inputs pass through unchanged.
  WebP encoding and other codecs can be added without changing service ownership.
- Header inspection before worker decode: 20 MiB input, 24 million pixels,
  16384px maximum edge for PNG/JPEG. The browser HEIC path checks its 20 MiB
  source before decode and its 50 MP dimensions before canvas allocation.
  These limits intentionally reject oversized images even if a smaller
  derivative could theoretically be created.

App startup installs the service. The attachment resolver calls it before
reading upload bytes/base64; name/MIME/size/URI describe the resulting file.
Both original and derivative are checked against the inline byte limit before
base64 allocation. A `.heic`/`.heif` filename recovers an empty browser MIME.
The composer aborts processing when the attachment is removed or owner unmounts.
No remote requests contain the image during compression; only codec assets load.

Verification: `node --import tsx --test tests/image-processing.test.ts
tests/workbench-attachment-resolver.test.ts` from repository root, plus
`node --import tsx scripts/test-image-processing-browser.ts` (Playwright env
overrides supported). The browser test builds production assets, checks WASM
HTTP success, exact PNG pixels including alpha, JPEG sizing, cancellation and
the actual attachment data URL.
