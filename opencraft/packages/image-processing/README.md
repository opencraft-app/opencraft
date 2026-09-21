# Upload image processing

Independent Cordis `imageProcessing` service. Owns CPU admission (one active
job, at most 16 waiting), cancellation and disposal. No Hermes, filesystem,
AppServer, React, object-URL or Blob-cache ownership. Browser codec is injected.

`compress(blob, { signal, onProgress })` returns a Blob plus changed/reason.
Stages are queued/inspecting/decoding/encoding, not invented percentages.
Original File is never mutated. An output at least as large as its input is
discarded. Cache is not involved: this processes private local upload data.

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
- APNG, GIF, WebP, SVG, HEIC and other unsupported inputs pass through unchanged.
  WebP encoding and other codecs can be added without changing service ownership.
- Header inspection before decode: 20 MiB input, 24 million pixels, 16384px
  maximum edge for supported images. These limits intentionally reject oversized
  supported images, even if a smaller derivative could theoretically be created.

App startup installs the service. The attachment resolver calls it before
reading upload bytes/base64; name/MIME/size/URI describe the resulting file.
The composer aborts processing when the attachment is removed or owner unmounts.
No remote requests contain the image during compression; only codec assets load.

Verification: `node --import tsx --test tests/image-processing.test.ts
tests/workbench-attachment-resolver.test.ts` from repository root, plus
`node --import tsx scripts/test-image-processing-browser.ts` (Playwright env
overrides supported). The browser test builds production assets, checks WASM
HTTP success, exact PNG pixels including alpha, JPEG sizing, cancellation and
the actual attachment data URL.
