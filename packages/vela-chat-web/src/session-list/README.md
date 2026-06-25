# Session List Model

This folder owns the session-list row read-model for web and desktop hosts.
Surfaces should render `SessionListRowModel` fields instead of re-deriving
titles, previews, status badges, recency text, or action labels in JSX.

Recency is a low-priority floating hint, not an exact timestamp and not a
layout column that defines the sidebar edge. The model suppresses very fresh
activity and emits compact coarse labels only after the fresh window, so UI
code should not format minute strings directly. The surface may align the hint
near the row's right side, but it should stay visually inset and secondary.

`defaultSessionListText` is intentionally local for now. Replace it with the
future i18n text provider at this boundary.
