# Sidebar Settings Menu

This folder owns the desktop shell settings menu that appears in the sidebar
footer.

It is intentionally render-only shell chrome:

- `SidebarSettingsMenu` renders the Codex-style footer trigger and menu surface.
- Consumers provide intent callbacks such as `onOpenSettings` and
  `onClearSessions`.
- The menu does not know about velad, ChatUI, or any concrete settings store.

Keep product/runtime settings panels outside this folder. The sidebar should
only expose the entry points.
