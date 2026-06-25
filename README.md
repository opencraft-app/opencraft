# velaChat

Localhost-first, multi-client, multi-backend agent runtime.

## Quick start

Install JavaScript and Rust dependencies once:

```bash
make install
```

## Desktop preview workflow

Use the desktop preview target while working on the Electron shell or the
work-monitor mini window:

```bash
make desktop-preview
```

This is the fast feedback loop. It does not package or copy anything to
`/Applications`; it runs the Electron dev host directly.

- `target/debug/velad` is built first.
- Electron spawns that local `velad` child and waits for the `velad.ready`
  stdout event.
- Vite renderer prefers `http://127.0.0.1:5173/`; if that port is busy,
  the dev script uses Vite's assigned fallback port and prints the actual URL.
- Electron opens the desktop shell against the Vite renderer.
- Renderer/CSS changes update through Vite. Electron main/preload/window-manager
  changes require restarting `make desktop-preview`.

For work-monitor visual iteration:

1. Run `make desktop-preview`.
2. Create or open a Codex session and send a message.
3. The mini window opens from local send intent and then follows the
   read-model thumbnail state.
4. Iterate React/CSS in `apps/vela-desktop-electron/src/work-monitor/` or
   `packages/vela-chat-web/src/thumbnail/`; those are visible without a
   package/install cycle.

If the preview window shows `Failed to fetch`, check DevTools Network first:

- Good: requests go to the `apiBaseUrl` reported by desktop bootstrap.
- Bad: requests go to `file:///api/v1/...`.
- `file:///api/v1/...` means the renderer is not using the dev server or the preload bridge did not load.

Before restarting a stuck preview, clear the usual Electron process. You should
not need to kill port `5173` just because it is already occupied:

```bash
pkill -f 'node_modules/electron/dist/Electron.app' || true
make desktop-preview
```

## Desktop build and install

For fast local macOS arm64 packaging without signing:

```bash
make desktop-install-dev
```

This builds the Rust server, builds the Electron renderer/main/preload bundles, packages an unsigned macOS arm64 app, copies it to `/Applications/Vela.app`, and opens it.

For the signed packaging path:

```bash
make desktop-install
```

Signing can be slow because Electron apps contain many framework files. Use `desktop-install-dev` for normal UI iteration unless you specifically need the signed artifact.

Other useful targets:

```bash
make server-run
make desktop-dev
make desktop-preview-fast
make desktop-dev-web
make desktop-build
make desktop-pack-dev
make desktop-dist
make desktop-clean
make desktop-pids
```

## Runtime model

The desktop app is designed to work in two modes:

- Dev preview: `make desktop-preview` lets Electron spawn and manage a local
  debug `velad`.
- Packaged app: the app should use the bundled `velad` from the Electron resources when present.

The desktop host passes the resolved API base URL into the renderer through the preload bridge. The renderer should not hard-code `file:///api/v1` or assume the app is always served from HTTP.

## Sidebar shell model

The desktop shell separates layout state from transient overlay behavior:

- Standard toggle opens and closes the docked sidebar.
- The docked sidebar owns layout width and can be resized.
- When the docked sidebar is closed, the left edge trigger can reveal a transient overlay sidebar.
- The overlay sidebar fades in/out quickly and closes after navigation, outside click, or focus leaving the overlay.
- Chat and session list surfaces are kept embeddable so future web/mobile hosts can mount them independently.

## Documentation

The first SPEC draft lives under `content/docs` and is configured for Fumadocs MDX.

```bash
npm install
npm run dev
```

The docs content is intentionally written before implementation so the server boundary, domain model, and API contracts stay explicit.
