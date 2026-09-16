# Memory display boundary

`agent-settings-page.tsx` retains the request IDs, active Bot/profile references, snapshots, quota-save mutual exclusion and SDK restart callback. Its `MemoryLimitCard` retains draft/touched/editing state and only exits editing when the original save callback returns success. Cancel resets the draft to the latest limit.

`agent-memory-views.tsx` provides typed display components:

- `MemoryPanelView`: title/description, refresh action, loading/error text, supplied quota cards, controlled Memory/User tabs and their entries.
- `MemoryLimitCardView`: quota values and bounds, controlled draft/editing/validation state, labels and edit/change/save/cancel callbacks. It only owns accessible IDs and explicit cancel-focus restoration.
- `MemoryEntriesView`: plain entries and empty text; preserves line breaks and wraps long words.

Views have no repository, context, request or SDK imports. All labels and derived validation messages come from the host. The host exports its existing `MemoryPanel` display adapter for direct rendering tests without constructing a second page/session owner.

Radix Tabs do not refresh or query data when switching entries. Both quotas remain disabled while either save is pending. Failed and partial saves retain the editor, draft and error. Requests, config/restart/reread sequencing, Profile targeting and stale-response rejection are unchanged.
