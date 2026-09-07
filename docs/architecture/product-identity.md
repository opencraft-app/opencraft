# OpenCraft product identity

OpenCraft is the product name for the Web, Electron, and Expo hosts. Source
packages use `@opencraft/*`; build environment variables use `OPENCRAFT_*`
and `VITE_OPENCRAFT_*`. There are no old package aliases or dual environment
variable readers. Electron remains pinned to 44.1.0.

## Brand is not data identity

The Electron display name is OpenCraft. The installed application ID remains
`ai.lightvela.vela`, and the iOS bundle ID remains `dev.vela.workbench`.
These identify existing installations, not their display label. The desktop
profile directory is explicitly `@vela/workbench-electron` under the platform
app-data directory (verified from the installed Mac app and its existing DSH data);
it is set before instance locking, Chromium session creation, and daemon startup.
DSH keeps its existing `dsh` subdirectory. The daemon socket, token filename,
and wire handshake identity are unchanged so rebranding cannot launch a second
runtime against an existing profile.

Existing `vela.*` plugin/View/host IDs, `vela-bot:` resource URIs, IndexedDB names,
local-storage keys and serialized projection fields remain canonical identities.
There is only one schema and one reader, not a compatibility fork. Default-product
storage remains unprefixed, while the LightVela product partition is unchanged.

AppServer capability strings (`vela/agents`, `vela/bot-conversations`,
`vela/browser-use`) and published browser tool names stay stable. The source
constant names have changed to OPENCRAFT, but a product rename is not a wire
protocol version change. Generic `thread/*`, `turn/*`, and `bot/*` methods are
unchanged. Native deep links now use `opencraft:`.

## Service-provider ownership

LightVela remains a service-provider plugin. Its domains, OAuth callbacks,
account identifiers, backend names and configuration do not become OpenCraft.
Third-party DSH, Hermes and Codex reference sources are not rebranded.

## Checkout and release

The product does not depend on the physical checkout path or its basename.
Deployment directories and running installations are not moved by
source rebranding. Mac builds now produce `OpenCraft.app`, and scripts use
explicit `OPENCRAFT_MAC_*` settings. Builds must be deployed separately; source renaming
does not replace the running production website or Mac application.
