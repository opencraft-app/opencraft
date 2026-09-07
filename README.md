# OpenCraft

OpenCraft is a clean-room, maintainable TypeScript workbench built from the latest
recovered Codex renderer semantics. It has two real renderer hosts over one
semantic application model and an explicit supervisor for lifecycle-scoped
runtimes: Vite/React DOM for desktop Web and Electron, and Expo Router for iOS,
Android, and Expo Web.

Branding, installed application identity, storage, and protocol namespaces are
separate concerns. See [product identity](docs/architecture/product-identity.md)
for the OpenCraft naming policy and the identifiers intentionally kept stable.

## Run

Use Node **26.7.0** (`nvm install && nvm use`) and npm 11. Public npm access is
required; desktop packaging also downloads Electron and builder tools from
their upstream release servers. No private package registry or reference
source tree is required. Do not copy `node_modules` from another computer.

```bash
git clone git@git.woa.com:wisp/opencraft.git
cd opencraft
npm ci
npm run dev:web
```

The browser UI starts without a configured model account. To execute agent
tasks, add your own AppServer in **Settings → Connections**, or use the desktop
app's built-in Local Agent. Model credentials are runtime configuration, not
build inputs and never part of this repository.

### Desktop with the bundled Local Agent

On the target machine (macOS or Linux with a desktop session):

```bash
npm ci
npm run dev:electron
```

This builds the renderer and main process and prepares DSH from the committed
`runtime/dsh/package.json` and `package-lock.json`. The runtime uses an isolated
`npm ci`; it never installs into the root workspace. Open **Settings → Local
Agent** to configure your provider/model credentials. Building and the startup
smoke test do not require an API key.

For distribution, build on the **same OS and CPU architecture** as the target:

```bash
# Apple Silicon Mac; use :x64: instead on an Intel Mac
npm run package:electron:mac:arm64:zip
npm run package:electron:mac:arm64:dmg
# Linux x64
npm run package:electron:linux:x64:appimage
```

Native dependencies may need Python 3 and a C/C++ toolchain (Xcode Command Line
Tools on macOS; make/g++ on Linux). DMG and native iOS builds require macOS;
iOS also needs Xcode and CocoaPods. macOS signing/notarization credentials are
optional for local unsigned builds, and required for trusted public distribution.
Cross-OS/CPU desktop packaging is rejected because DSH contains native modules.

### Expo

```bash
npm run dev:expo:web
# On macOS with Xcode/CocoaPods; use an endpoint reachable from the device
EXPO_PUBLIC_APPSERVER_WS_URL=ws://YOUR_SERVER:9988/rpc npm run dev:expo:ios
```

Native Expo defaults to loopback, not a developer's server. Set the URL on a
physical device; loopback there refers to the device itself. Workspace paths
come from the connected host, not from this checkout.

### Clean-checkout verification

```bash
npm ci
npm test
npm run matrix:build -- web-browser electron-renderer electron-host expo-web expo-ios-bundle
npm run prepare:dsh-runtime
npm run smoke:local-agent
```

See [fresh-machine builds](docs/fresh-machine-builds.md) for platform boundaries,
optional remote-Mac setup, and what is intentionally not committed.

The Web workbench treats every execution node as a complete Host runtime. A
single same-origin AppServer is discovered automatically. Multiple nodes can be
declared without changing renderer code:

```bash
VITE_APPSERVER_HOSTS_JSON='[
  {"hostId":"dev","label":"Development","kind":"remote-ssh","url":"wss://dev.example/rpc"},
  {"hostId":"durable","label":"Durable","kind":"durable","url":"wss://durable.example/rpc"}
]' npm run dev:web
```

Host selection precedes project/folder selection. Threads, Draft workspace,
Replica state, query keys, panels, and persisted selection are all scoped by
`hostId`. Host URLs containing credentials are rejected; authentication belongs
to the Web/Electron transport gateway.

The renderer is semantic React/TypeScript and SCSS. It does not execute the
generated recovery runtime. Provenance is pinned in
`vendor/codex/IMPORT_MAP.json` to the r822 semantic source tree and the r823 to
r826 audit, build, browser-differential, and hydration gates.

## Workspace

- `apps/workbench-web`: React DOM + Vite renderer for browser and Electron.
- `apps/workbench-electron`: Electron main/preload host without a second UI.
- `apps/workbench-expo`: Expo Router host for native and Expo Web.
- `packages/appserver-protocol`: host-aware Codex app-server transport types.
- `packages/chat-core`: typed `Turn -> DisplayItem` projection.
- `packages/composer-core`: serializable cross-platform composer blocks.
- `packages/codex-composer`: ProseMirror composer with IME-safe input,
  attachments, mentions, skills, commands, history, and send/stop semantics.
- `packages/design-system`: typed Codex theme compiler plus Web and Native tokens.
- `packages/workbench-runtime`: renderer-free session store, commands and
  streaming lifecycle consumed by both renderer hosts.

The Expo host uses Unistyles 3 over one canonical React 19 instance. It is a
custom native development build, not an Expo Go target. `npm run
build:expo:ios` runs the Linux-compatible Metro iOS bundle gate; launching an
Apple Simulator and compiling the native pods still require macOS and Xcode.

The frame contract and exact recovery evidence are documented in
`docs/codex-frame-spec.md`. Platform boundaries and reuse rules are documented
in `docs/platform-architecture.md`. The Cordis-backed extension kernel,
capability boundary and future marketplace model are documented in
`docs/plugin-architecture.md`; the AI-native discovery, task lease, execution
journal and generated-capability model are documented in
`docs/agent-capability-fabric.md`. The package ownership and proof ladder for
automated changes are documented in `docs/agent-iteration-guide.md`.
