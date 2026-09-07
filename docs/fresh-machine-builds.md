# Fresh-machine build contract

The Git checkout plus public, locked dependencies is the complete build input.
`vendor/codex/IMPORT_MAP.json` and PROVENANCE documents are historical references,
not files loaded by installation, build, tests, or application startup.

## Inputs and ownership

- Root `package-lock.json`: application workspace dependencies; install with `npm ci`.
- `runtime/dsh/package-lock.json`: independently installed Local Agent runtime.
  Only its manifest/lockfile are committed, never its dependencies or user data.
- `.nvmrc`: tested build Node version; Electron stays pinned to 44.1.0.
- Native toolchains: provided by the target OS. Native binaries must not be
  copied from a different OS/CPU. Desktop packaging checks this before packing.
- Credentials and endpoints: configured by each user at runtime. Web/Expo need
  a reachable AppServer to execute tasks. Desktop owns a bundled Local Agent.

`prepare:dsh-runtime` validates both manifests before invoking npm, passes an
explicit installation prefix and disables workspace discovery, checks the
installed version/executable, then records a manifest/lock/platform/ABI digest.
Missing or incomplete installations cannot be reported ready. The prepare step
must leave root developer tools (Vite, TypeScript, etc.) installed.

`smoke:local-agent` starts the real locked DSH runtime in a fresh temporary data
directory, checks AppServer initialize/thread-list through WebSocket, and shuts
it down. It does not reuse a developer DSH home or make a paid model request.

After packaging, verify the shipped runtime outside the source directory:

```bash
# Linux example; on macOS use the executable and Resources inside OpenCraft.app
node scripts/smoke-packaged-runtime.mjs \
  /absolute/path/to/linux-unpacked/opencraft \
  /absolute/path/to/linux-unpacked/resources
```

This runs DSH with the packaged Electron Node, not the system Node or checkout
dependencies, and checks its host API from a fresh temporary working directory.

For GUI first-run testing, pass Electron's `--user-data-dir=/absolute/temp/path`
to the packaged executable. OpenCraft creates that profile before initializing
Electron storage, so testing does not reuse or replace an existing installation's
data. Without that explicit override, the stable default profile is retained.

## Remote Mac (optional)

Ordinary Mac builds run locally and do not need SSH. The convenience sync/build
script is optional and requires explicit user-owned configuration:

```bash
OPENCRAFT_MAC_SSH_USER=YOUR_USER \
OPENCRAFT_MAC_REPO=/absolute/path/to/opencraft \
OPENCRAFT_MAC_SSH_HOST=YOUR_BUILD_MAC \
OPENCRAFT_MAC_SSH_PORT=22 npm run update:mac
```

No developer username, home path or internal service IP is a build default.
Historical `/vela` paths in test fixtures are synthetic identity data; they are
not read from the host filesystem. Persisted application identity remains stable
as explained in [product identity](architecture/product-identity.md).

Build outputs, installed dependencies, runtime data, private keys, and `.env`
files stay ignored. Keep secret-bearing configuration outside source control;
an ordinary `git clone` must never contain a working user's credentials.

## Verified coverage (2026-09-07)

Tested from source snapshots containing only the candidate Git tree, with new
dependency installations and temporary runtime/profile directories:

- Linux x64 / Node 26.7.0: workspace install, unit tests, type checks, Web,
  Electron renderer/host, Expo Web and iOS JavaScript bundle, release packaging.
- macOS arm64 / Node 26.3.0: workspace install, locked DSH install, native ZIP
  packaging, artifact-name verification.
- Both desktop platforms: real DSH/AppServer WebSocket startup, packaged DSH
  running under bundled Electron Node outside the checkout, and CDP verification
  of the actual packaged GUI with a newly created profile.

This does not claim verification of Windows, Intel Mac native packaging, native
iOS archives, notarization, or paid model inference. Model credentials must be
configured by the person running the app.
