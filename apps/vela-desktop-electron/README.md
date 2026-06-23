# vela-desktop-electron

Electron host for the reusable Vela desktop experience.

This app is intentionally thin:

- Electron main opens the desktop window and injects the API base URL.
- The shared desktop web entry composes `vela-desktop-shell`, `vela-chat-controller`, and
  `vela-chat-web`.
- Chat state and wire contracts stay in shared packages and Rust crates.

Run `velad` separately before launching this app. The host expects it at
`127.0.0.1:3857` by default, or at `VELA_DESKTOP_VELAD_LISTEN_ADDR` when set.

From the repository root:

```bash
npm install
npm --prefix apps/vela-desktop-electron run dev
```

Pure web host mode uses the same desktop shell and ChatUI without launching
Electron. It is the browser equivalent of the desktop window and is useful for
debugging, visual iteration, and embedding tests. The browser talks to the
same-origin `/api/v1` path; Vite proxies that path to `velad` so the web host
does not depend on daemon CORS settings:

```bash
VITE_VELA_PROXY_TARGET=http://127.0.0.1:3857 \
  npm --prefix apps/vela-desktop-electron run dev:web
```

For quick one-off checks you can still override the browser-facing API base
from the URL:

```text
http://127.0.0.1:5173/?api_base_url=/api/v1
```

Build the desktop host without launching it:

```bash
npm --prefix apps/vela-desktop-electron run build
```

The package is excluded from the root Next/Fumadocs typecheck. Treat it as a
separate desktop host: keep Electron/Vite packaging here, while shared chat
behavior stays in the packages above.
