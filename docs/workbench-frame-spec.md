# OpenCraft frame specification

The frame has transparent title chrome, sibling left navigation, an elevated
main content surface, an optional right child panel, centered thread content,
a top fade and a bottom composer. Layout state, measurements and animation
progress have distinct owners.

Numeric window and panel limits are defined by the current
[shell-space contract](../packages/workbench-runtime/src/shell-space.ts) and
[window metrics](../packages/workbench-runtime/src/window-metrics.ts).
Theme geometry, typography, spacing and appearance are owned by the
[design system](../packages/design-system/src/tokens.shared.ts).

The [Shell layout invariants](architecture/workbench-shell-layout-invariants.md)
define width conservation, full-width mode, mount lifetime and local overflow.
A resizing or closing panel must preserve draft and content identity. Native
adapters retain platform ownership of measurement and animation.
