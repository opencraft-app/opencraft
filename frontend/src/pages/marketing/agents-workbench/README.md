# Agents Workbench

`agents-workbench` owns the product-level Vela entry under `/agents/workbench`.

Responsibilities:
- Load the mono2 bot list through `repositories.bots` and pick the VM that hosts `velad`.
- Auto-inject and start VM `velad` through `debug/exec` before opening the TAT transport.
- Build a mono2-specific `velad` transport through TAT port forwarding.
- Mount a web-embedded workbench: local session rail plus Vela `SessionListSurface` and `ChatSurface`.

Non-goals:
- Do not import the Electron desktop app shell or its global stylesheet into this Next page.
- Do not reimplement Vela chat rendering.
- Do not import velalink's demo proxy path as the mono2 endpoint.

Layering:
- `AgentsWorkbenchPage` is a thin bot loader.
- `VelaWorkbenchDesktopHost` adapts a mono2 bot VM to an embedded workbench shell.
- `velad-transport.ts` owns VM/direct HTTP connection details.
- `host-state.ts` owns local browser state slots for selected session, drafts, scroll, and future host preferences.
- `velalink/` remains the source for Vela ChatUI surfaces and Rust app server code.
