# Native chat attachments

Ordinary chat, assistant chat and native group chat use OpenCraftComposer for selection, paste, attachment drafts and acceptance. Channels supply the upload port; they do not duplicate editor state. A receipt acknowledges submitted attachment IDs and, when applicable, the submitted document. Newer content is preserved by the Composer owner.

Native communication owns immutable attachment bytes and message admission in the same transaction. The authenticated Channels RPC is shared by desktop and headless, advertises attachments version 1, and rechecks membership before returning bytes. Uploads are bounded to 8 MiB and names to 160 characters; retry identity includes name, MIME, content and byte hash. File downloads are user-triggered. Only validated PNG/JPEG content is used for inline image previews.

The personal assistant may read only incoming files from its claimed owner. Its Host passes bounded 64 KiB chunks over the existing private stdio peer; it never widens the pipe frame limit or grants arbitrary paths. Import uses the existing immutable profile attachment store, before the durable inbox cursor advances. Reception validates IDs through that store and captures metadata alongside its original input. Codex receives actual PNG/JPEG input and bounded UTF-8 text/JSON content. Other binary files are retained and downloadable, but decoding is not claimed. Attachment bytes do not enter telemetry or long-term memory by default.

External provider capability remains separate. Existing PNG/JPEG forwarding uses the original native image outbox. A synchronized group without a file-delivery transport rejects ordinary files before persistence; the draft remains available. This does not implement WeCom file forwarding or document conversion.

The browser channel attachment adapter normalizes PNG/JPEG MIME from a bounded
16-byte content header, not the filename or browser MIME hint. Selection, paste,
drop and edited images share the Composer resolver; the Channels client repeats
the same normalization for older drafts and other callers. It preserves name,
bytes, modification time and submission identity. A claimed PNG/JPEG with an
unrecognized header is rejected rather than promoted by its extension. Cancelled
preparation cannot publish a late file into another draft.

Format detection is separate from size policy: external PNG/JPEG delivery remains
limited to 2 MiB, while native/direct attachments retain their existing 8 MiB
limit. Only an authoritative external-file refusal is refined into an oversized
image or unsupported-format notice; it never becomes a local-only success or a
fallback send. The original image and accompanying text remain in the draft.

`channel-attachment-file.test.ts` covers MIME normalization, cancellation,
bounded reads and transport identity. `channel-attachments.test.ts` also connects
the browser client to real native storage and the external-image outbox without
contacting an external provider. `channel-attachment.browser.ts` uses the actual
Shell/IM/Composer with synthetic RPC to exercise picker/paste/drop and rejected
draft retention on desktop and touch layouts. Provider delivery and physical
devices are separate acceptance checks.

Validation: channel-attachments.test.ts covers authority, retries, limits and bounded owner reads; composer-core.test.ts covers partial acceptance and newer edits; inbound-attachments.test.mjs covers admission/context; codex-harness.test.mjs verifies actual native HTTP image/text inputs against a loopback provider. smoke-channel-attachments.ts exercises the real Workbench plus picker, native RPC/storage, previews/downloads and draft settlement across touch/desktop light/dark. Live model accuracy and physical devices remain separate checks.
