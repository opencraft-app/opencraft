# Session Drag Preview Renderer

Renderer for the transient native session drag preview window.

This folder may connect to the local runtime and render the reusable
`ConversationPreviewSurface`. It must not create windows, call Electron main
process modules, or duplicate ChatUI thumbnail DOM.
