# conversation-runtime/model

Pure item-model helpers for the app-side conversation runtime.

Change here when stream item construction, item-level segmentation, or
virtualization thresholds change.

Host-aware runtime policy also belongs here. The renderer passes the
`ChatRenderModel.host.kind` through the Web adapter, then
`conversationRuntimePolicyForHost` decides whether partial virtualization is
enabled before segments are built.

Do not:
- Import React.
- Read DOM scroll state.
- Fetch velad data.

Depends on:
- `adapters`

Used by:
- `conversation-runtime/strategy`
- `components/conversation`
