# Work Monitor Renderer

Renderer host for the floating work monitor window.

This folder may wire runtime bootstrap, velad client state, and the reusable
session preview shell. It must not own thumbnail row semantics and must not
import Electron main-process modules.

The shared thumbnail window chrome lives in
`apps/vela-desktop-electron/src/session-preview`; keep scale, title overlay,
status styling, and frame treatment there.

The monitor body is a drag surface, not a navigation button. Keep pointer source
handling in `work-monitor-interaction.ts`; the only explicit monitor action in
the preview chrome is the small close icon.
