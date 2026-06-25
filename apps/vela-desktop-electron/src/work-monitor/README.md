# Work Monitor Renderer

Renderer host for the floating work monitor window.

This folder may wire runtime bootstrap, velad client state, and the reusable
thumbnail surface. It must not own thumbnail row semantics and must not import
Electron main-process modules.

The reusable thumbnail DOM lives in `packages/vela-chat-web/src/thumbnail`.
