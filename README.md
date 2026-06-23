# velaChat

Localhost-first, multi-client, multi-backend agent runtime.

## Quick start

Install JavaScript and Rust dependencies once:

```bash
make install
```

## Desktop preview workflow

Use the desktop preview target while working on the Electron shell:

```bash
make desktop-preview
```

This starts the full local development stack:

- `velad` runs on `127.0.0.1:3857`.
- Vite renderer runs on `http://127.0.0.1:5173/`.
- Electron opens the desktop shell against the Vite renderer.
- The renderer receives `VITE_VELA_API_BASE_URL=http://127.0.0.1:3857/api/v1`.
- The Electron preload bridge exposes desktop bootstrap state to the renderer.

If the preview window shows `Failed to fetch`, check DevTools Network first:

- Good: requests go to `http://127.0.0.1:3857/api/v1/...`.
- Bad: requests go to `file:///api/v1/...`.
- `file:///api/v1/...` means the renderer is not using the dev server or the preload bridge did not load.

Before restarting a stuck preview, clear the usual local ports/processes:

```bash
lsof -tiTCP:5173 -sTCP:LISTEN | xargs -r kill || true
lsof -tiTCP:3857 -sTCP:LISTEN | xargs -r kill || true
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
make desktop-dev-web
make desktop-build
make desktop-pack-dev
make desktop-dist
make desktop-clean
```

## Runtime model

The desktop app is designed to work in two modes:

- Dev preview: `make desktop-preview` starts a local external `velad` and points Electron at it.
- Packaged app: the app should use the bundled `velad` from the Electron resources when present.

`VELAD_LISTEN_ADDR` controls the server address used by Makefile targets:

```bash
VELAD_LISTEN_ADDR=127.0.0.1:3860 make desktop-preview
```

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
