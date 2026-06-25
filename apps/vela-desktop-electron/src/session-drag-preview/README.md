# Session Drag Preview Renderer

Renderer for the transient native session drag preview window.

This folder may connect to the local runtime and render the shared session
preview shell. It must not create windows, call Electron main process modules,
or duplicate ChatUI thumbnail DOM.

The drag preview must reuse `apps/vela-desktop-electron/src/session-preview`
so it stays visually identical to the work monitor thumbnail.
