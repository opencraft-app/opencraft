# Work Monitor Window

Electron local session work-monitor window lifecycle for the floating
thumbnail window.

This folder may import Electron main-process APIs and local runtime helpers. It
must not import React, `ChatSurface`, `useVelaChatSession`, or thumbnail row
rendering logic.

The window hosts the reusable web thumbnail surface through the renderer bundle.
It does not perform screenshots, offscreen bitmap rendering, or native screen
capture.

When multiple displays are connected, the monitor is positioned by the Electron
main process on the same display as the main desktop window. Renderer code must
not read screen coordinates or decide native window placement.

Dragging is also a host-window concern. The renderer may report pointer deltas
for the work-monitor window, but only this Electron main-process layer moves
the native `BrowserWindow`.
