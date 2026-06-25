# velaChat

Localhost-first, multi-client, multi-backend agent runtime.

## Mono2 integration caveat

When velaChat is edited through the `mono2/velalink` subtree, remember that
`mono2/frontend` does not import that directory directly. The frontend imports
`velachat` from `frontend/node_modules/velachat`, and that dependency is pinned
by `frontend/package.json` plus `frontend/pnpm-lock.yaml`.

So a source edit under `mono2/velalink/` is not enough to make the local
`mono2/frontend` preview pick it up. A local node_modules sync can unblock a
debug session, but the durable path is:

1. Commit and push the velaChat change upstream.
2. Update mono2 frontend's `velachat` git commit pin.
3. Reinstall frontend dependencies.
4. Rebuild and verify the affected frontend preview.

This matters for workbench event-stream issues such as `TAT proxy websocket
closed`: verify that the built frontend is using a `velachat` pin that contains
the reconnect/error-handling fix, not only that the subtree source was edited.

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
make server-release-linux-amd64
make server-upload-cos
make server-vm-install-command
make server-vm-install-debug-exec
make desktop-dev
make desktop-dev-web
make desktop-build
make desktop-pack-dev
make desktop-dist
make desktop-clean
```

## VM velad injection workflow

The Linux VM path is intentionally Makefile-driven so the desktop/web host does
not hide deployment state in UI code.

Build the `velad` daemon for a Linux amd64 VM:

```bash
make server-release-linux-amd64
```

Publish the binary to Tencent COS:

```bash
VELAD_COS_BUCKET=your-bucket-name \
VELAD_COS_REGION=ap-beijing \
VELAD_COS_SECRET_ID=... \
VELAD_COS_SECRET_KEY=... \
make server-upload-cos
```

`server-upload-cos` writes:

- `target-linux-amd64/velad-linux-amd64.url`
- `target-linux-amd64/velad-linux-amd64.sha256`

Generate the command that should run inside the VM:

```bash
make server-vm-install-command
```

Inject that command through mono `debug/exec`:

```bash
MONO_BOT_ID=ins_xxx \
MONO_AUTH_TOKEN=... \
make server-vm-install-debug-exec
```

The VM install script downloads the published binary, verifies SHA-256 when a
checksum is available, starts `velad` on `127.0.0.1:3857`, and persists the
SQLite event log under the VM user's `${HOME}/.local/share/velalink`.

Secrets must stay in environment variables or the caller's secret manager. Do
not commit COS or mono credentials into this repository.

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
