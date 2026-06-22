# conversation-runtime/scrollbar

Self-drawn web scrollbar overlay for the conversation surface.

The browser element still owns real scrolling. This folder mirrors its metrics
into a cross-platform thumb and maps thumb drags back to `scrollTop`, following
the same boundary as Paseo's web scrollbar.

Change here when scrollbar geometry, visibility, or thumb drag behavior changes.

Do not:
- Own bottom-follow or history paging rules.
- Build conversation stream items.
- Render chat blocks.

Depends on:
- React
- `styles`

Used by:
- `components/conversation/VelaConversation.tsx`
