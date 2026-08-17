# Transient inbound attachment delivery design

Date: 2026-08-17

## Goal

Let a running Agent reliably discover and inspect image/file messages received through Tencent IM without making
Vela Platform, Backend, or Computer a second chat-history or attachment-storage authority.

Tencent IM remains the sole source of truth for message bodies and remote attachment bytes. Vela creates only a
short-lived, launch-scoped capability that authorizes the current Agent to fetch one attachment on demand.

## Confirmed failure

The current path has two independent losses:

1. `gojaim` groups `TIMImageElem` with file/audio/video elements, but its generic projector expects top-level
   `uuid/fileName/fileUrl/fileSize` fields. Tencent image payloads use `imageInfoArray`, so image elements often
   reach the Gateway with `Attachment == nil` and are skipped.
2. Even a valid file attachment remembered by the Gateway is discarded by `runtimehost`: cold wake JSON and warm
   `runtimeapi.Delivery` carry text only. Image-only/file-only messages therefore become empty Runtime input.

The Web composer attachment chip is unrelated: it represents a local draft until the Human presses Send.

## Authority and persistence boundary

- Tencent IM owns message history and remote attachment bytes.
- Backend and Platform store no inbound attachment body, signed Tencent URL, or chat transcript.
- The Computer may hold an in-memory capability registry scoped to one Agent Gateway/runtime epoch.
- Incoming attachment capability state is not written to the existing filesystem `attachmentstore`.
- Existing filesystem staging for Agent-originated, not-yet-sent outgoing attachments remains unchanged.
- Runtime restart or Gateway replacement invalidates all old inbound handles. Replaying Tencent history creates
  new handles.

## Data model

Add a shared runtime-facing value that contains only safe display metadata and an opaque local capability:

```go
type AttachmentRef struct {
    ID        string
    Filename  string
    MIMEType  string
    SizeBytes int64
}

type Delivery struct {
    Text        string
    Attachments []AttachmentRef
    Mode        string
    Transient   bool
}
```

`ID` is a random, unguessable launch-scoped handle. It is not the Tencent file UUID, message ID, or signed URL.

The Gateway registration result becomes structured:

```go
type MessageRegistration struct {
    Target      string
    Text        string
    Attachments []runtimeapi.AttachmentRef
}
```

## Tencent projection

`gojaim.projectMessageElements` uses element-specific projectors:

- `TIMFileElem`: retain the existing top-level file projection.
- `TIMImageElem`: select the original image (`imageType == 0`, otherwise the first item) from `imageInfoArray` and
  project URL, size, dimensions, and a deterministic provider identity derived from the Tencent message ID plus
  the image variant. Generate a safe display filename when Tencent supplies none.
- Audio/video remain separate explicit projectors; they must not accidentally inherit the image schema.

Projection failure retains only a redacted diagnostic shape in-process and cannot silently claim that the
attachment was registered. Raw provider URLs, query strings, Tencent file identities, and opaque payload values
must never be serialized to logs, prompts, Runtime JSON, or persisted state.

## In-memory capability registry

The Agent Gateway owns an `InboundAttachmentRegistry` containing metadata only:

- capability ID;
- authorized route ID and visible target;
- Tencent message reference and provider attachment identity;
- safe filename, MIME type, size, and current remote URL;
- runtime epoch and expiry.

Properties:

- random 128-bit-or-stronger IDs;
- within one Gateway/runtime epoch, idempotently reuse the same handle for the tuple
  `(route ID, visible target, Tencent message reference, provider attachment identity)`;
- maximum 512 entries per Gateway;
- two-hour absolute TTL;
- target/route/runtime-epoch authorization on every download;
- zero attachment bytes cached by the registry;
- expired and oldest entries evicted in memory;
- registry destroyed with the Gateway.

History, search, resolve, and live ingress may all observe the same Tencent attachment. They must converge on the
same handle inside one epoch rather than consuming registry capacity or changing CLI-visible IDs. A new epoch
creates a new handle.

The existing Tencent URL allowlist, redirect bound, TLS floor, private-network dial rejection, and 50 MiB size
limit remain mandatory. Provider URLs never cross into Runtime JSON or prompts.

When a capability is viewed, the Gateway fetches bytes from Tencent and streams them to the loopback Agent API.
If the signed URL has expired, the implementation may rehydrate the attachment from Tencent history using the
stored message reference before returning a bounded failure. Rehydration is optional in the first implementation;
returning an explicit expired-capability error is preferable to persisting the URL.

## Runtime delivery

Both ingress paths consume the same `MessageRegistration`:

- Cold start: `encodeWakeMessage` includes `attachments[]`; `runtimeprompt.formatWakeMessage` renders attachment
  IDs and an explicit `vela attachment view --id ... --output ...` instruction.
- Warm Agent: `runtimeapi.Delivery.Attachments` is populated. Codex, Hermes ACP, and Hermes Gateway render the same
  safe attachment hint even if they do not yet support native multimodal resource blocks.

Every attachment-bearing delivery also carries a non-empty, generated text hint before entering a Runtime driver.
`Attachments` supplements `Text`; it does not replace it. This preserves the current Codex, Hermes ACP, and Hermes
Gateway requirement that delivery text is non-empty while making image-only/file-only messages valid input.

Image-only messages must never become empty delivery. A safe initial rendering is:

```text
[Image attachment: screenshot.png, id=attc_..., image/png, 136000 bytes]
Download and inspect it before answering content-dependent questions:
vela attachment view --id attc_... --output .vela/tmp/screenshot.png
```

The standing Runtime guidance requires downloading and inspecting an attachment before answering a question that
depends on its content. The first version uses the existing CLI and local model tools; direct Codex/ACP image
resource blocks are a later adapter enhancement, not a prerequisite for restoring visibility.

## API and CLI behavior

`vela attachment view` keeps its current interface. The loopback download handler resolves:

1. inbound transient capability IDs from the in-memory registry; or
2. existing outbound attachment IDs from filesystem staging/remote-send records.

Inbound and outbound IDs use distinct prefixes so authority and lifecycle cannot be confused.

Compatibility is fail-closed: the download route accepts an inbound capability only from the live in-memory
registry, and accepts a filesystem-backed record only when it is an outgoing attachment record. Persisted legacy
`DirectionIncoming` records are rejected and may be garbage-collected separately; they never remain valid across
the upgrade.

No new Backend route, database table, COS object, or public download URL is introduced.

## Error behavior

- Invalid/missing image payload: preserve a visible unsupported-attachment marker; do not emit an empty message.
- Expired/unknown handle: return `attachment_capability_expired` without exposing provider details.
- Unauthorized target/runtime epoch: return the existing safe authorization failure.
- Tencent download failure: return a bounded safe upstream diagnostic; do not retry an unbounded number of times.
- Oversized body or size mismatch: reject before writing the final CLI output file.

## Tests

Required regression coverage:

1. Tencent `TIMImageElem.imageInfoArray` projects an original image attachment.
2. File/audio/video schema handling stays explicit and unchanged.
3. Image-only ingress creates a non-empty registration with an opaque capability ID.
4. The inbound registry is in-memory, TTL-bounded, capacity-bounded, and runtime-epoch/target scoped.
5. Repeated live/history/search/resolve observation reuses one handle inside the same epoch.
6. Provider URL, URL query, raw payload, and Tencent UUID never appear in wake JSON, Runtime delivery, prompt,
   persisted state, or logs.
7. Cold launch receives attachment metadata, non-empty text, and download guidance.
8. Warm delivery receives the same attachment metadata and non-empty text.
9. `vela attachment view` streams the expected bytes through the authorized loopback route.
10. Gateway replacement invalidates an old handle; Tencent history replay creates a new one.
11. Persisted legacy incoming records are rejected while outgoing records remain valid.
12. Existing outgoing attachment upload/send behavior remains green.

Add one end-to-end test from Tencent image payload through `gojaim`, Gateway registration, runtimehost cold/warm
delivery, CLI download, and safe prompt rendering.

## Rollout

This is an Agent/Computer change, not a Web or Backend schema release. Publish it in the next Computer Release Set
after Agent tests, Rust TAT tests, TUI reproducibility checks, dual-platform build, independent signature
verification, and controlled local attachment fixture acceptance pass.

Do not activate it on the current degraded shared Canary until the Backend is healthy enough to serve Computer
install/update requests reliably.

## Non-goals

- storing Tencent chat history in Backend or Platform;
- copying inbound attachment bytes to Vela COS;
- exposing signed Tencent URLs to a model;
- keeping inbound handles valid across Gateway/runtime epochs;
- native multimodal blocks for every Runtime in the first slice;
- changing the Web composer draft presentation.
