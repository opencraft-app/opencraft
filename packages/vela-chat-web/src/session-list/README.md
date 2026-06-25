# Session List Model

This folder owns the session-list row read-model for web and desktop hosts.
Surfaces should render `SessionListRowModel` fields instead of re-deriving
titles, previews, status badges, rail time, or action labels in JSX.

The right rail is a low-priority recency hint, not an exact timestamp. The
model suppresses very fresh activity and emits compact coarse labels only after
the fresh window, so UI code should not format minute strings directly.

`defaultSessionListText` is intentionally local for now. Replace it with the
future i18n text provider at this boundary.
