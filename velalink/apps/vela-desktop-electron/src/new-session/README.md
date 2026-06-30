# Desktop New Session

Electron host container for the reusable Vela new-session surface.

This folder owns desktop defaults, backend setup selection, and the submit
payload shape for creating a local `velad` session. It may import reusable chat
packages, but it must not import Electron main/preload/runtime modules.

`DesktopApp` should treat this as a page-level route surface: open it by
default, open it from "new session" actions, and leave chat rendering to the
selected-session branch.
