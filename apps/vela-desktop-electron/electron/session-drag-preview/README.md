# Session Drag Preview Window

Electron main-process lifecycle for the transient session drag preview window.

This folder owns native `BrowserWindow` creation, placement, mouse-event
passthrough, and hide/close behavior. It must not import React, ChatUI, velad
client hooks, or renderer components.

The sidebar renderer reports session drag intent with screen coordinates. This
main-process layer turns that intent into a small transparent always-on-top
window that follows the pointer. The renderer bundle loaded inside the window
owns the read-model and visual thumbnail.
