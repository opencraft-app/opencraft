# Sidebar Resize

This folder owns the desktop shell sidebar resize interaction.

Resize is intentionally local to the desktop shell:

- It does not belong to ChatUI.
- It does not belong to the velad/OpenAPI wire contract.
- It should not be reimplemented in session list or frame CSS.

The model is the source of truth. Pointer preview, keyboard resize, and pointer
commit must all use the same `resolveSidebarResize` result. Never commit the raw
`clientX - shellLeft` value directly; that recreates the snap-back bug where the
preview clamps to one width but the final React state commits another.

Dragging left has three intentional zones:

- in range: the sidebar follows the pointer exactly.
- overscroll band: the pointer can move left of the minimum width while the
  visible sidebar remains pinned to `minWidthPx`.
- collapse intent: once the pointer moves below `collapseBelowPx`, the commit
  sets `isSidebarVisible` to `false` while preserving the clamped width.
