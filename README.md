# OpenCraft

Contribute through [CONTRIBUTING](CONTRIBUTING.md). To build a client extension, start with the [current boundary guide](docs/extension-development.md) and [runnable example](examples/extensions/README.md).

OpenCraft core is developed in this GitHub upstream. Product providers and
branding are composed downstream; see [transition status](docs/upstream-transition.md).
Original contributions use Apache-2.0; existing third-party notices and source
records are retained. npm publication is deferred.

OpenCraft is a maintainable TypeScript agent workbench. It has two renderer hosts over one
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
git clone https://github.com/opencraft-app/opencraft.git
cd opencraft
npm ci
npm run dev
```

Private product assembly belongs to downstream workspaces. Trusted local build
entries can compose the same complete client without making public installation
depend on a private account provider. See [plugin architecture](docs/plugin-architecture.md).

`npm run dev` (also `npm run dev:local`) prepares the pinned DSH engine and
starts local execution and Web together on a loopback address. Open the printed
URL, choose **Configure models**, save your provider credentials/endpoint, then
return to Chat. No OpenCraft account is required. Model credentials remain with
the execution Host; they are never build inputs. Local development data persists
in `~/.opencraft/dev-local`, independently of desktop/server installations.
`OPENCRAFT_DEV_DATA_DIRECTORY` selects another isolated data directory and
`OPENCRAFT_DEV_PORT` changes the Web port (default 5173). Stop with Ctrl+C.

`npm run dev:web` starts only the frontend. Without an explicit endpoint or saved
connection, it offers local-start instructions and an existing server address.
Opening a server takes you to that server's own website and sign-in flow.
Explicit `VITE_APPSERVER_HOSTS_JSON`, `VITE_APPSERVER_WS_URL`, and website deployment
configuration remain supported; a temporary connection failure never clears them.

### Managed Web installation and public npm releases

The self-hosted Web package is `@opencraft-app/opencraft` on the public npm registry
`https://registry.npmjs.org/`. It includes the website and managed updater.
The public execution package also includes the managed gateway and daemon; Codex core, CLI and DSH engine remain independently deployed. The first public release supports Linux x64 and Node.js 24. See the
[Web deployment and public npm release runbook](docs/web-deployment.md) for
installation, credential selection, publishing, rollback and Playwright checks.
Source development above uses public dependencies; distributing this Web package
uses the public npm registry.

To build from source and replace an existing server installation directly, follow
the [local server replacement guide](docs/web-local-deployment.md).

### Docker Compose

For a Linux ARM64 Docker installation with independent data storage and
execution on the host, use the [Docker Compose deployment guide](docker/README.md).

### Desktop with the bundled Local Agent

On the target machine (macOS or Linux with a desktop session):

```bash
npm ci
npm run dev:electron
```

This builds the renderer and main process and prepares DSH from the committed
`runtime/dsh/package.json` and `package-lock.json`. The runtime uses an isolated
`npm ci`; it never installs into the root workspace. Use Settings to configure
your provider/model credentials. Building and the startup smoke test do not
require an API key.

For a macOS QA preview that cannot overwrite an existing window or profile,
use the isolated profile and ad-hoc package procedure in the
[build matrix](docs/build-matrix.md). `dev:electron` is a developer loop,
not proof of a packaged desktop release.

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
npm run prepare:dsh-runtime
npm test
npm run matrix:build -- web-browser electron-renderer electron-host expo-web expo-ios-bundle
npm run smoke:local-agent
```

See [fresh-machine builds](docs/fresh-machine-builds.md) for platform boundaries,
optional remote-Mac setup, and what is intentionally not committed.

The Web workbench treats every execution node as a complete Host runtime. A
managed website injects deployment configuration into HTML before startup:
`OPENCRAFT_APPSERVER_URL` supplies `local` (managed site), and
`OPENCRAFT_CODEX_APPSERVER_URL` supplies `local-codex` (managed site). Generic npm
packages retain both Hosts and built-in Agent settings without deployment build
variables. `OPENCRAFT_HYPERNODE_USER` remains a private proxy header; managed websites
disable the HyperNode plugin to avoid a duplicate primary Host.

For development/tests, an explicit build-time Host list takes precedence over
the website configuration, without merging the lists:

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

The renderer is semantic React/TypeScript and SCSS. It shares the same renderer across Web and Electron.

## Workspace

See the [repository layout](docs/repository-layout.md) for documentation, tooling,
build inputs and task records.

- `apps/workbench-web`: React DOM + Vite renderer for browser and Electron.
- `apps/workbench-electron`: Electron main/preload host without a second UI.
- `apps/mobile`: Expo Router host for native and Expo Web.
- `apps/bridges/hermes`: independently installed Bun bridge from Hermes to the AppServer protocol.
- `packages/appserver-protocol`: Host-aware AppServer contracts and generated native Codex types.
- `packages/chat-core`: typed `Turn -> DisplayItem` projection.
- `packages/composer-core`: serializable cross-platform composer blocks.
- `packages/composer-editor`: ProseMirror composer with IME-safe input,
  attachments, mentions, skills, commands, history, and send/stop semantics.
- `packages/design-system`: typed OpenCraft theme compiler plus Web and Native tokens.
- `packages/workbench-runtime`: renderer-free session store, commands and
  streaming lifecycle consumed by both renderer hosts.

The Expo host uses React Native, HeroUI Native and Uniwind over one canonical
React 19 instance. The public entry runs the shared native Workbench; downstream
products select their own entry and configuration explicitly. See the
[Expo guide](apps/mobile/README.md) for Expo Go previews, native builds
and their platform requirements. `npm run build:expo:ios` runs the
Linux-compatible Metro iOS bundle gate; launching an Apple Simulator and
compiling the native pods still require macOS and Xcode.

The frame layout contract is documented in
`docs/workbench-frame-spec.md`. Platform boundaries and reuse rules are documented
in `docs/platform-architecture.md`. The Cordis-backed extension kernel,
capability boundary and future marketplace model are documented in
`docs/plugin-architecture.md`; the AI-native discovery, task lease, execution
journal and generated-capability model are documented in
`docs/agent-capability-fabric.md`. The package ownership and proof ladder for
automated changes are documented in `docs/agent-iteration-guide.md`.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and the
repository's security checks. A passing build does not establish that dependencies,
Git history or third-party licensing are ready for a public release.
