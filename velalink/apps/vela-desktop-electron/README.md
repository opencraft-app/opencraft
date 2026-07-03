# vela-desktop-electron

Electron host for the reusable Vela desktop experience.

This app is intentionally thin:

- Electron main opens the desktop window and injects the API base URL.
- The shared desktop web entry composes `vela-desktop-shell`, `vela-chat-controller`, and
  `vela-chat-web`.
- Chat state and wire contracts stay in shared packages and Rust crates.

Packaged macOS builds embed the local `velad` daemon and start it through the
Electron runtime manager. The bundled daemon binds `127.0.0.1:0` and reports its
real address with a `velad.ready` stdout event. Development mode follows the
same local lifecycle: the dev script builds `target/debug/velad` and lets the
Electron host spawn it as a child process.

From the repository root:

```bash
npm install
npm --prefix apps/vela-desktop-electron run dev
```

The root Makefile exposes the same fast feedback loop:

```bash
make desktop-preview
```

Use this for Electron shell and work-monitor iteration. It builds
`target/debug/velad`, starts Vite, launches Electron, and lets the Electron host
spawn that local daemon. It does not package the app or replace
`/Applications/Vela.app`.

Renderer, thumbnail, and work-monitor CSS/React changes update through Vite.
The preview server prefers port `5173`, but if that port is already in use the
dev script uses Vite's assigned fallback port and passes that exact URL to
Electron.
The preview host also sets `VELA_DESKTOP_USER_DATA_DIR` to
`.tmp/desktop-preview-user-data` under the repo so its runtime SQLite database
does not share writes with the packaged `/Applications/Vela.app`.
`make desktop-preview` first clears older dev preview processes from this repo;
use `make desktop-preview-stop` when you only want to stop the running dev
preview without starting it again.
Restart `make desktop-preview` after changing Electron main/preload code or
window-manager values such as work-monitor width, height, shadow, or
always-on-top behavior.

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

desktop-dev
  -> desktop-preview
```

`desktop-pack` and `desktop-dist` are macOS arm64 targets. They build release
`velad`, copy it into the app resources, and the packaged app starts that daemon
automatically. The Electron dev target builds `velad` in debug mode and passes
`VELA_DESKTOP_VELAD_PATH=target/debug/velad` plus isolated preview user data to
the host; it does not connect to an externally managed daemon.

Use `make desktop-install-dev` only when you need to validate the packaged app
under `/Applications/Vela.app`. `make desktop-pids` shows both dev preview and
packaged `Vela`/bundled `velad` processes so you can tell which runtime is still
alive.

## Local runtime

Electron host lifecycle code lives under `electron/runtime/`. It owns local
`velad` process startup, ready parsing, diagnostics, graceful shutdown, and
rotating logs. It does not import React renderer code or
`packages/vela-desktop-shell`.

The local runtime contract is `velad.local.v1`; the business API contract
remains `velachat.v1` under `/api/v1`.

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
