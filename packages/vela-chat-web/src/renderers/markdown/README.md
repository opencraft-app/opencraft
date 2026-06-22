# renderers/markdown

Change here when the Markdown rendering engine or Markdown leaf chrome changes.

This folder owns the chat Markdown leaf renderer. It follows the Codex-style
shape: `marked` parses Markdown into tokens, Vela renders those tokens into
React DOM, and streaming Markdown gets a separate repair/cache/fade path.

Live streaming has one extra layer before parsing:

- `liveTextBuffer.ts` is the pure pacing state machine.
- `useBufferedStreamingText.ts` owns the browser scheduler.
- `StreamingMarkdownRenderer.tsx` parses the buffered visible text and applies
  the streaming repair/cache/fade path.

When a turn completes, the live renderer should settle its remaining buffered
text before the block returns to the static renderer. Do not flush the final
full string directly on `turn.completed`; that creates the same chunky output
the buffer exists to avoid.

Static and streaming output share `renderTokens.tsx`; do not introduce a second
renderer stack for completed messages. Conversation layout, turn boundaries,
agent work, and message shells must stay outside this folder.

Do not:
- Group turns or split conversation items.
- Render agent work or tool calls.
- Read OpenAPI fields.
- Manage scrolling or composer state.

Depends on:
- React
- `marked`
- `styles`

Used by:
- `renderers/blocks/AssistantMarkdownRenderer`
