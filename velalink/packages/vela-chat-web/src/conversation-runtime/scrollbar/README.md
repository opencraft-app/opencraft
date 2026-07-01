# conversation-runtime/scrollbar

Self-drawn web scrollbar overlay for ChatUI scroll surfaces.

Read `../scroll/SCROLL_MODEL.md` before changing behavior. The overlay is only
the visual scrollbar and pointer-input adapter; route resume, bottom-follow,
history paging, and persistence are owned by `conversation-runtime/scroll`.

The browser element still owns real scrolling. This folder mirrors its metrics
into a cross-platform thumb and maps thumb drags back to `scrollTop`, following
the same boundary as Paseo's web scrollbar. Conversation-specific persistence
is a wrapper concern; other surfaces such as the session list reuse the generic
vertical overlay directly.

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
- `surfaces/SessionListSurface.tsx`
