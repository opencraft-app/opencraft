# Shared presentation and preview owners

Web utility dialogs consume `@opencraft/design-system-web/modal-surface`.
`ModalContent` is exported from `@opencraft/design-system-web/modal-content`.
`ModalSurface` is the full controlled window recipe; `ModalContent` adapts an existing Radix Root with domain-owned trigger, title, actions and pending policy. The shared presentation root keeps portals local to embedded Workbenches. App compatibility exports refer to this same owner. Forms keep their validation, requests and close permission. Native implementations consume ModalDescriptor instead of DOM primitives.

Read-only image, table, SVG and attachment previews consume `PreviewSurface` from the same package. It owns native top-layer admission, ShadowRoot continuity, IME Escape, focus restoration and finite animation completion. It admits content before measuring gestures and defers dismissal until exit finishes; reduced motion is immediate. Content engines retain their selection, copy/download and editing semantics.

`file-preview-core` owns identity, leases, cancellation, bounds and engine disposal. `file-preview-web` supplies the adapter registry and current View. PDF and native audio/video are built-in lazy adapters; Office and structured documents remain registered plugins. A renderable document may project React content into its retained element while the engine remains owned by its lease. PDF page/zoom survive View detachment; parser/worker disposal follows pool eviction or tab release.

`FilePreviewDialog` accepts only resource identity, display name and a cancellable Blob reader. Trusted group/assistant attachments supply the authenticated channel reader; preview code receives neither filesystem paths nor credentials. Its transient tab is released on close. File panels consume the same registry with their persistent tab identity. The registry stays eager metadata; the shared View, table expansion and native preview surfaces activate on demand. Pending presentation consumes the common IME-safe cancellation helper.
The provider supplies optional-resource preparation and the existing appearance preference. Unsupported formats retain download.

`MediaPlayer` shares native-control playback and Blob-URL ownership across inline messages, tools and adapters. Inactivation, document hiding and detachment pause playback; no transition resumes it automatically. `downloadBlob` shares temporary URL cleanup across attachment and file actions.

Full business pages keep the existing navigation stack. Composer editing keeps its draft, editor and upload transaction; it consumes the shared modal content without becoming a read-only file adapter. HTML, MCP Apps, browser sessions and remote desktops retain their isolation and existing owners.
