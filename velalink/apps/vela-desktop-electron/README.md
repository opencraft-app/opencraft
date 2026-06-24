# vela-desktop-electron

Electron host for the reusable Vela desktop experience.

This app is intentionally thin:

- Electron main opens the desktop window and injects the API base URL.
- The shared desktop web entry composes `vela-desktop-shell`, `vela-chat-controller`, and
  `vela-chat-web`.
- Chat state and wire contracts stay in shared packages and Rust crates.

Packaged macOS builds embed the `velad` daemon and start it from the Electron
main process. Development mode can still point at an external daemon at
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

The repository root also exposes Makefile targets for the Electron packaging
stack:

```bash
make server-build
make desktop-build
make desktop-pack
make desktop-dist
```

macOS arm64 packaging dependency graph:

```text
server-release
  -> embedded Resources/bin/velad
server-build
  -> desktop-build
       -> desktop-pack
       -> desktop-dist

server-run + desktop-dev
  -> stack-dev
```

`desktop-pack` and `desktop-dist` are macOS arm64 targets. They build release
`velad`, copy it into the app resources, and the packaged app starts that daemon
automatically. Dev targets still use `VELA_DESKTOP_VELAD_LISTEN_ADDR` /
`VELAD_LISTEN_ADDR`, defaulting to `127.0.0.1:3857`.

## Local logs

The Electron main process is the desktop runtime host for local logging. It
captures host messages plus bundled `velad` stdout/stderr and writes them under:

```text
~/Library/Application Support/Vela/logs/vela-desktop.log
```

Logs rotate locally before they can grow without bound. Defaults:

- `VELA_DESKTOP_LOG_MAX_BYTES=5242880`
- `VELA_DESKTOP_LOG_MAX_FILES=5`

This is intentionally local-file logging first. If Vela later exports OTLP, keep
the local rotating log as the offline fallback and add OTLP export as a separate
runtime host sink.

`desktop-pack` creates an unpacked app directory under
`apps/vela-desktop-electron/release`; `desktop-dist` creates platform
installers with `electron-builder`.

The package is excluded from the root Next/Fumadocs typecheck. Treat it as a
separate desktop host: keep Electron/Vite packaging here, while shared chat
behavior stays in the packages above.
