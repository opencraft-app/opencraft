# OpenCraft product identity

OpenCraft is the product name for the Web, Electron, and Expo hosts. Source
packages use `@opencraft/*`; build environment variables use `OPENCRAFT_*`
and `VITE_OPENCRAFT_*`. There are no old package aliases or dual environment
variable readers. Electron remains pinned to 44.1.0.

## Directory identity charter

Brand, installation identity, product data, runtime state and task workspace are
separate identities. No layer may derive one from another implicitly.

Codex provides the reference shape: `CODEX_HOME`, otherwise `~/.codex`, is a
stable product authority while each Thread carries an explicit workspace cwd.
WorkBuddy likewise exposes a product-owned `dataFolderName`, normally
`~/.workbuddy`, rather than treating Electron's launch directory as Agent state.
OpenCraft follows the same model without copying either product's filenames.

### Canonical roots

| Role | macOS canonical path | Owner | Persistence |
|---|---|---|---|
| Installed application | `/Applications/OpenCraft.app` when installed | Installer / user | Replaceable binary; read-only at runtime |
| Packaged resources | `OpenCraft.app/Contents/Resources` | Build artifact | Versioned with the application; never written |
| Desktop application state | `~/Library/Application Support/OpenCraft` | Electron Main | Durable platform state |
| Preview application state | `~/Library/Application Support/OpenCraft Preview` | Electron Preview Main | Durable but isolated from production |
| Managed runtime root | `<desktop-state>/runtime` | Electron Main | Stable cwd and runtime-owned files |
| DSH state | `<desktop-state>/dsh` | Local Agent Host / DSH | Durable engine state |
| Codex state | `<desktop-state>/codex` | OpenCraft Daemon / Codex Engine Adapter | Account Pool metadata, private credentials and isolated native runtime state |
| Daemon endpoint and token | `<desktop-state>/opencraft-daemon.sock` and `opencraft-daemon.token` | Electron Main / Daemon | Runtime coordination; never shared with Preview |
| Product home | `OPENCRAFT_HOME`, otherwise `~/.opencraft` | OpenCraft product services | Portable product configuration, Projects, Skills and model definitions |
| Project workspace | Explicit Project/Thread cwd | Project catalog / Thread | User-owned files |
| Projectless workspace | `<product-home>/workspaces/<stable-id>` | Conversation creation transaction | Durable until explicitly removed |

Installation IDs are explicit per platform and build profile:

| Host/profile | Identifier |
|---|---|
| Desktop installed app | `ai.lightvela.vela` |
| Android Expo Go and internal APK | `dev.vela.workbench` |
| Android LightVela signed release APK | `com.tencent.vela` |
| iOS development and internal IPA | `dev.vela.workbench` |
| iOS LightVela test IPA | `ai.lightvela.vela` |

The Expo release profiles are selected by `OPENCRAFT_ANDROID_RELEASE=1` and
`OPENCRAFT_IOS_RELEASE=1` in `apps/workbench-expo/app.config.js`. A changed
identifier is a separate installation; it does not update the old package.
Bundle compatibility does not authorize a Vela-named data root.

### Authority rules

1. One platform path resolver computes every canonical root before instance
   locking, Chromium session creation, database opening or daemon startup.
   Feature code consumes resolved paths; it does not call `homedir()`,
   `app.getPath("appData")` or `process.cwd()` to invent storage.
2. `process.resourcesPath` is the only packaged-resource authority. Runtime
   code never writes into the app bundle and does not depend on where the bundle
   was mounted, downloaded or launched.
3. Every managed Main, Daemon and DSH process has an explicit cwd equal to the
   managed runtime root. The cwd is operational context only, never a data or
   workspace lookup fallback.
4. Every Agent execution receives an explicit Project/Thread cwd. Missing cwd
   is rejected or resolved through the projectless-workspace transaction; it
   never falls back to `/`, the checkout, the app bundle or `process.cwd()`.
5. Product home and desktop application state are different roots. Product
   configuration can move between clients; Chromium state, sockets and local
   databases remain platform-private.
6. Preview and production never share application state, sockets, databases,
   credentials or runtime cwd. Explicit test overrides remain authoritative and
   never trigger production-profile migration.

### Legacy migration

`~/Library/Application Support/@vela/workbench-electron` and
`@vela/workbench-electron-preview` are legacy inputs, not canonical destinations.
The production migration must run before `app.setPath("userData")` and before
single-instance/daemon ownership is acquired:

1. An explicit `--user-data-dir` wins and disables automatic migration.
2. If the OpenCraft root exists, use it and do not merge a legacy tree into it.
3. If only the legacy production root exists, atomically rename it to the
   OpenCraft root on the same volume, then create a compatibility link from the
   legacy path to the canonical root for the supported rollback window.
4. After the durable tree moves, rename the legacy daemon token to its OpenCraft
   filename and discard stale socket files; sockets are process artifacts, not
   migratable data. Migration proceeds only after proving no legacy daemon owns
   the profile.
5. If migration cannot complete, continue on the intact legacy root and report
   a bounded diagnostic; never start with an empty new profile or partially copy
   databases.
6. Preview state is migrated only by the Preview product and never from or into
   the production profile.
7. Migration is idempotent, lock-aware and covered for success, existing-new,
   explicit override, rollback and concurrent-old-version cases. Removing the
   compatibility link is a later explicit migration, not cleanup during startup.

### Implementation state

Current source resolves and prepares the complete directory plan before
single-instance ownership, appends the same `--user-data-dir` for Chromium
helpers, sets Electron userData, and switches Main to the managed runtime cwd.
Daemon and DSH receive that runtime directory explicitly. New native Threads
reject a missing workspace cwd instead of inheriting process cwd.

The migration moves an inactive legacy profile atomically, renames the daemon
token, discards stale sockets and creates the rollback compatibility link. An
active legacy runtime defers migration and a post-rename failure rolls back to
the intact legacy profile. Explicit `--user-data-dir` profiles skip migration.

Migration occurs only when a rebuilt application is installed and launched;
building source alone never moves a machine's profile.

Existing `vela.*` plugin/View/host IDs, `vela-bot:` resource URIs, IndexedDB names,
local-storage keys and serialized projection fields remain canonical identities.
There is only one schema and one reader, not a compatibility fork. Default-product
storage remains unprefixed, while the LightVela product partition is unchanged.
These compatibility IDs do not authorize new Vela-named filesystem paths,
directories, sockets, tokens, databases or logs.

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
