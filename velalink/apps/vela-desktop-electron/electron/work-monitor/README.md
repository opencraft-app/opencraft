# Work Monitor Windows

Electron local session work-monitor window lifecycle for floating thumbnail
windows.

This folder may import Electron main-process APIs and local runtime helpers. It
must not import React, `ChatSurface`, `useVelaChatSession`, or thumbnail row
rendering logic.

Each visible session owns at most one native monitor window. Reopening the same
session reuses its existing window and does not reset a user-dragged position;
opening another session creates a separate window. Each window hosts the
reusable web thumbnail surface through the renderer bundle. It does not perform
screenshots, offscreen bitmap rendering, or native screen capture.

Native window metrics are shared with the session drag preview through
`apps/vela-desktop-electron/electron/session-preview`; only placement policy
belongs here.

When multiple displays are connected, the monitor is positioned by the Electron
main process on the same display as the main desktop window. Renderer code must
not read screen coordinates or decide native window placement.

Dragging is also a host-window concern. The renderer may report pointer deltas
for a work-monitor window, but only this Electron main-process layer maps the
sender to its owning session window and moves the native `BrowserWindow`.
