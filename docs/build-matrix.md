# OpenCraft Build Matrix

The repository has one shared semantic core and multiple delivery surfaces. A
successful TypeScript build is not evidence that every surface is deployable,
so each surface is an explicit matrix target with its own artifact contract.

| Target | Renderer/runtime | Output | Build host |
| --- | --- | --- | --- |
| `web-browser` | Vite, HTTP origin, same-origin `/appserver` gateway | Hashed static release | Linux/macOS/Windows |
| `electron-renderer` | Vite, origin-root asset URLs, Electron loopback origin | Relocatable renderer tree | Linux/macOS/Windows |
| `electron-host` | Sandboxed Electron main/preload + static loopback origin + independent OpenCraft Daemon | Main/preload, daemon executable and pinned DSH runtime | Linux/macOS/Windows |
| `electron-macos-arm64-zip` | Electron host + renderer | Apple Silicon `.app` ZIP | Linux/macOS |
| `electron-macos-arm64-preview` | Electron host + renderer | Isolated Apple Silicon ad-hoc `.app` ZIP | macOS |
| `electron-macos-arm64-dmg` | Electron host + renderer | Apple Silicon DMG | macOS |
| `electron-macos-x64-zip` | Electron host + renderer | Intel `.app` ZIP | Linux/macOS |
| `electron-macos-x64-dmg` | Electron host + renderer | Intel DMG | macOS |
| `electron-macos-universal-release` | Native arm64 + native x64 Electron apps | Signed, notarized Universal DMG and ZIP | GitHub Actions macOS arm64 + Intel |
| `electron-linux-x64-appimage` | Electron host + renderer | Portable x86_64 AppImage | Linux |
| `electron-linux-x64-rpm` | Electron host + renderer | TencentOS/RHEL/Fedora RPM | Linux |
| `electron-linux-x64-deb` | Electron host + renderer | Debian/Ubuntu amd64 package | Linux |
| `headless-linux-amd64-tar` | Node Local Agent Host + Vite WebUI + bundled headless Electron browser | Self-contained private server `.tar.gz` | Native Linux amd64 |
| `expo-web` | Packaged Web Workbench + Metro Web | Expo static export | Linux/macOS/Windows |
| `expo-ios-bundle` | React Native + Metro | JS bundle and assets | Linux/macOS; native archive on macOS |
| `expo-android-internal-apk` | Expo prebuild + Gradle release | Installable internal APK | Linux/macOS with JDK and Android SDK |
| `expo-android-release-apk` | Expo prebuild + Gradle, external PKCS12 signing | Configured public application ID, signed APK and filing text | Linux with JDK, Android SDK and release key |

## Repository-owned Electron source fork

[`vendor/electron`](../vendor/electron/README.md) owns the fixed Electron source
baseline, checksummed patch series and explicit source/sync/build commands. Its
initial native patch exposes observation-only editing metadata and caret bounds;
source verification is separate from compilation and real native input testing.
Normal desktop and browser-runtime packages continue using their existing pinned
distribution until a compiled custom artifact is explicitly integrated and
validated. The fork's initial build entry targets Linux; macOS/Windows builds and
physical input-method validation remain separate work.

## Developer diagnostics and browser evidence

Default builds, `npm run gate` and public product-entry tests use the current
OpenCraft implementation. Prepare the separate locked execution runtime with
`npm run prepare:dsh-runtime` before running the full gate.

The work-status diagnostic runs against the current production components,
including final-response transitions and reading-position measurements:

```sh
WORK_TRANSITION_ONLY=1 npx tsx scripts/diagnose-work-status-completion.ts
```

Connector catalog exports require an explicit local input. Missing arguments
fail with usage before reading files:

```sh
node scripts/export-hermes-connector-catalog.mjs /absolute/marketplace
```

The catalog exporter emits metadata; it does not install a connector or connect
to a service.

Goal and navigation-avatar browser probes write screenshots to a unique system
temporary directory and print its path. They do not require `/data`, and retain
the evidence for inspection. Browser selection still uses
`OPENCRAFT_CHROMIUM_EXECUTABLE` when needed.

## Browser compatibility

The browser baseline is Safari 16.6 / iOS Safari 16.6–16.7 (including iPadOS
16.7.x), Chrome 116 and Firefox 115. Core flows must work; optional device
features may degrade through capability detection and a usable fallback.
`config/browser-compatibility.mjs` is the shared build/lint source of truth.
Vite uses its browser targets for syntax lowering. Before application or trusted
product modules evaluate, both the HTML and embedded entry load the shared
`runtime/browser-compatibility.ts` boundary. It installs curated core-js standard
Iterator helpers, Promise.withResolvers, Object/Map.groupBy and Set operations
using feature detection. Existing native implementations are retained when
conformant. A dynamic import separates application evaluation from these effects,
including third-party top-level calls. Product configs inherit this core entry
contract. Web and Electron renderers share it; Workers and Expo are separate
realms and are not covered. DOM, CSS, device APIs and proposals are not shimmed.
The typed gate continues rejecting newer APIs in owned application code; these
shims defend dependency/product startup rather than relaxing the baseline.

`npm run smoke:browser-bootstrap` launches an actual browser against the built
Web release, checks missing/native API behavior and reloads the real workbench.
Set `OPENCRAFT_CHROMIUM_EXECUTABLE` to a Chrome 116 binary for the minimum-engine
regression; without it the script tests the installed Playwright Chromium and
reports its actual version. The embedded bootstrap is also built and run with a
synthetic product whose top-level code needs these APIs. No account credentials
or model calls are used. CI pins Chromium 116 for this startup regression.

Every workbench renderer build runs `scripts/check-browser-compatibility.mjs`
after Vite exits, including release builds in CI. Vite records actual runtime
source modules, including lazy chunks, in an ignored local cache; npm archives
do not contain this list. The checker uses typed `eslint-plugin-es-x` rules
(through ES2023) plus `eslint-plugin-compat` for known browser globals. It does
not lint Node-only or type-only dependencies. Product-owned sources outside the
core workspace are included when the bundle actually imports them, including
lazy modules. The checker creates one ESNext/DOM analysis program from that
graph; a product tsconfig with narrower declarations cannot hide unsupported
APIs. No product directory is recursively scanned. The cache retains relative
source locations and stays local, outside distributable archives. The graph owner
canonicalizes the workspace root before comparing Vite module IDs, so symlinked
checkouts and filesystem aliases retain the same module ownership.
Trusted external product sources retain normal dependency resolution first.
When a bare dependency is absent there, the Web build and typed compatibility
analysis can resolve it from this core workspace; existing renderer React
instance deduplication still applies. Headless and Relay bundling use the same workspace's
node_modules as a fallback after normal resolution, including the managed server
archive's explicit relay and Headless gateway entries. Relative, virtual, URL and
package-import specifiers keep their existing resolution. These are build-time
contexts, not paths supplied through HTTP or runtime product JSON. Unresolved
TypeScript modules in the actual browser graph fail the compatibility check
rather than silently losing imported API types. Valid plain JavaScript imports
without declarations remain supported and retain the static-check limitations
below. The external dependency/type-resolution regression is included in both
browser compatibility and CI Web release tests.

The typed check is necessary:
transitive declarations can load ESNext even when tsconfig specifies ES2022.
Native Popover methods and `AbortSignal.any` are additionally rejected: use
existing Radix primitives. For a single cancellation/timeout owner, keep one
`AbortController` with an explicit deadline timer. When several real owners
overlap, import `combineAbortSignals` from
`@opencraft/appserver-client/transport` and dispose the combination at the
resource or operation lifecycle boundary that owns it; never keep it as a new
lease lifetime. `AbortSignal.any` is absent from Safari 16.6, and
`compat/compat` did not resolve that static for the baseline.

Run `npm run build:web:release` for a fresh graph and automatic check, or
`npm run lint:browser` to recheck source against the last build's graph after
editing. Adding imports requires a new build. For an explicit captured graph,
run `node scripts/check-browser-compatibility.mjs /path/to/module-graph.json`.
Malformed graphs, missing files and ignored/unparsed files fail the check. `npm run test:browser-compatibility`
contains positive/negative examples; CI's `test:web-release` also runs the lint
regressions. Node follows `.nvmrc`; the lint tooling remains development-only. The curated runtime shims above are
renderer dependencies, separate from the static checker.

Compatibility exceptions belong in `config/eslint.browser.config.mjs`, with a reason
and a tested fallback, rather than inline disables. The injected motion replay
clock named `scheduler` has a file-local exception for a plugin false positive;
it is not the experimental browser Scheduler API. Feature detection such as
`typeof window.requestIdleCallback === "function"` remains valid.

Static checks cannot prove CSS, arbitrary dynamic/any access, all DOM instance
methods, third-party code, hardware or permissions work. the downstream product's `smoke:browser-compatibility`
checks release startup/reload with modern optional APIs removed;
`smoke:browser-todo` checks the actual Radix plan popup without native Popover,
including touch, keyboard, dismissal, bounds and presentation-local portals.
These are capability simulations, not an iPad or Safari 16 engine certification.
Changes to core navigation, models or submission still need their normal
behavioral tests; optional preview/media errors must not break those flows.

## Pull-request CI selection

`build-matrix` runs on every PR, but `scripts/ci-plan.mjs` chooses its jobs from
Git's full merge-base diff. It includes deleted paths and both sides of a rename;
it does not use GitHub's limited workflow path filter or a paginated file API.
The reusable `ci-plan.yml` tests the selector and aggregate check without
installing npm packages and records selected work in the Actions summary.

Automatic validation defaults to Web and relevant Linux server regressions.
Electron, Expo and macOS builds require an explicit manual full-matrix request
or their existing release workflows. Automatic selection never widens to those
platforms, including for lockfiles, CI changes or an unreadable diff.

| Changed area | Automatic validation |
| --- | --- |
| Root Markdown, README/AGENTS, `docs/`, `design/`, `.agents/` | No product build or server archive; secrets scan and upstream contract remain |
| Web renderer source or shared CSS/SCSS | Web browser build, typecheck and React runtime tests |
| Expo application | Web compatibility build; native/Expo validation is opt-in |
| Electron Main/Preload/native code, Daemon, local agent host, DSH runtime | Linux server regressions; desktop/native validation is opt-in |
| Shared package/plugin code or unknown inputs | Web browser build, managed Web regression and Linux server regressions |
| Web update UI, Vite/static inputs, update/deployment scripts and tests | Managed Web regression and applicable Web/server checks |
| Root manifests/lockfile/toolchain or CI/selector changes | Web build, all installation-root audits, managed Web and Linux server regressions |
| Server archive/installer/deployment inputs or build artifact contract | Linux server regressions plus archive build and smoke test |

The server job installs dependencies once and always runs selected server tests;
archive building, archive smoke and upload are separately conditional. Shared
runtime or ordinary lockfile changes do not generate an installation archive.
An unreadable diff conservatively selects Web, audits, server regressions and the
server archive. Documentation changes do not run this product packaging job.

Manual `build-matrix` dispatch defaults to `validation: web`, exercising Web and
Linux server regressions. Choose `validation: full` to validate all five portable
targets, macOS native code and the Linux server archive. The `package_macos`
checkbox also selects full validation and uploads a macOS DMG; that packaging
job covers the separate native compile. CI DMGs use an explicit ad-hoc signature;
the job verifies the final image and the app copied from it, then launches that
app with isolated profile/model storage and checks its real renderer over CDP.
Logs and a screenshot are retained as `electron-macos-smoke`. These are test
packages, without Developer ID signing or Apple notarization; macOS may still
require an explicit Privacy & Security exception for a downloaded test app.
Signed/notarized release workflows and
their tag/manual triggers are unchanged. Manual CI DMGs and server archives are
retained for three days; release artifact retention is separate.

New commits cancel superseded build, security, CodeQL and upstream-contract runs
of the same PR. Jobs have bounded timeouts. No workflow-level path filter leaves
a required check pending: `build-checks` succeeds for an intentionally empty
build plan, but a selected job must succeed. A failed/cancelled/skipped selected
job, missing plan output or unexpected execution fails the aggregate. Use the
stable `build-checks`, `security-checks` and `upstream-contract` names in branch
protection; this policy does not change repository protection settings.

Dependabot runs weekly. Compatible minor/patch updates are grouped per npm
installation root, and compatible Actions updates are grouped together. Major
updates remain separate. Each ecosystem/root allows at most two simultaneous
version-update PRs; existing open PRs are not automatically closed. Security
update PR limits follow GitHub's separate policy.

The `security` workflow runs once per PR, on pushes to `main`, and weekly. PRs
only audit the npm installation roots selected by changed manifests/lockfiles;
CI/toolchain changes, main, weekly and manual runs audit all three roots so newly
disclosed vulnerabilities remain visible without a dependency change. Managed
Web E2E is selected by update/deployment and shared inputs, not every visual edit.
Selected audits retain complete findings for three days. Advisory dependency
findings remain advisory under the current upstream policy, independent of
repository visibility; installation/registry errors, secrets and functional
regressions still fail. See [Security](../SECURITY.md#upstream-audit-policy-2026-10-18).

Validate policy changes with
`node --test tests/tooling/ci-plan.test.mjs tests/tooling/ci-workflows.test.mjs tests/tooling/dependency-audit.test.mjs`
and `actionlint` on the affected workflows. Tests cover Web-only defaults,
explicit manual full requests, server tests versus archives, unavailable diffs,
advanced base branches, deleted/renamed files, and changes exceeding 300 paths.
The aggregate tests execute its actual shell script against success, failure,
skipped, cancelled and missing-selection states. These validate the scheduling
contract; they do not certify desktop/native products or replace release checks.

The browser and Electron targets intentionally do not share a built `index.html`.
They share source and chunks, but have different origin contracts. Electron
serves `electron-renderer` from a private, static-only loopback origin; loading
with `file://` would weaken navigation and asset policy. AppServer traffic does
not pass through that HTTP origin.

Commands:

```sh
npm run matrix:list
npm run matrix:check
npm run matrix:build -- web-browser electron-renderer electron-host
npm run matrix:build -- electron-linux-x64-appimage
npm run matrix:build -- electron-linux-x64-rpm
npm run matrix:build -- electron-linux-x64-deb
npm run matrix:build -- headless-linux-amd64-tar
npm run matrix:build -- expo-android-internal-apk
OPENCRAFT_ANDROID_RELEASE_KEYSTORE=/secure/path/release.p12 \
OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE=/secure/path/password.txt \
OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS=your-release-key \
  npm run matrix:build -- expo-android-release-apk
npm run package:electron:mac:arm64:preview
```

The Android internal target syncs an ignored native project, runs Gradle's
`assembleRelease`, verifies its signature, and copies the standalone APK plus a
SHA-256 file to `apps/mobile/release/`. Expo's generated release
configuration currently signs with its development keystore. This is suitable
only for internal installation; it is not a Play Store signing or publication
contract. `.github/workflows/android-internal-apk.yml` exposes a manual build
and downloadable Actions artifact after this subtree reaches the standalone
GitHub mirror; the nested workflow does not run downstream. The local
requirements and install command are in `apps/mobile/README.md`.

The public Android release target uses the public Expo configuration (the legacy
development identifier remains `dev.opencraft.workbench`). It requires a
repository-external production keystore, verifies the package ID and APK
signature against that keystore, and writes both the APK and filing values.
It never falls back to the internal development key. Private the downstream product release IDs,
edition selection and original artifact names belong to the explicit downstream
`products/<product>` build commands; public APK/IPA commands do not select that product.
`OPENCRAFT_NATIVE_ARTIFACT_NAME` is an optional trusted filename prefix, defaulting
to `OpenCraft`, for generic release APK and IPA output. The certificate MD5 and
APK file MD5 are different values. The [Expo mobile route](../apps/mobile/README.md#手机端路线)
also covers the temporary Expo Go preview, iOS test IPA and single-file
intranet download flow. An iOS IPA needs macOS, Xcode, CocoaPods and Apple
signing; `expo-ios-bundle` does not produce an IPA.

`electron-macos-universal-release` is an orchestrated delivery target rather
than a single-host matrix command. `.github/workflows/macos-universal-release.yml`
assembles arm64 on `macos-15` and x64 on `macos-15-intel`, merges only after both
native packages pass, then enters the `macos-release` Environment for signing,
notarization and final packaging. Manual runs are accepted only from `main`;
version tags matching `v*` additionally publish a GitHub Release. A lightweight
credential check in the same Environment runs before either native build, so
missing Secrets fail without consuming macOS build time. Configure the Environment
to allow only the `main` branch and `v*` tags.

The standalone core must not resolve downstream-parent `file:` dependencies. The downstream agent, chat-client and Collaboration snapshots now
belong to downstream `products/<product>/packages`, with their generator and checks in
that product. Run its `sync:shared-packages` when a corresponding `shared/`
authority changes, then `check:shared-packages`; the product owns these aliases
and the original generators. Public core contains no private compatibility CLI. Existing snapshot drift is reported
separately rather than silently regenerating current styling.

For downstream builds, the product config owns dependency resolution and Vite
deduplication for file-linked Collaboration sources, chat clients and messaging
SDKs outside the core checkout. Keep the
canonical chat package's messaging/platform subpath exports in its generated
snapshot; do not externalize those imports to make a release build succeed.
Verify the downstream product's `build:embedded:release` after changing either boundary.
This downstream build check is not standalone-mirror qualification.

Private Web presets and release aliases belong to downstream products, outside
this public matrix. A trusted product Vite config composes the exported
`createWorkbenchWebConfig(environment, features)` factory; explicit feature
choices cannot override core platform constraints. Core defaults do not select
private Next-style definitions, SDK dedupe, allowed hosts, proxy identity or
output directories. The core default Web/Electron build and publisher remain
unchanged. Product runners invoke the same preview bridge, noVNC patch, Vite and
browser compatibility stages, passing their config to Vite itself. Private
artifact boundary assertions remain product-owned and run before publication.

Desktop packaging jobs are downstream targets. Linux AppImage, RPM, and DEB
consume the same standard-Oxc-minified renderer and bundled host. No desktop
target applies the retired ultra compression or high-obfuscation pass. RPM is the native
TencentOS/RHEL/Fedora installation contract; AppImage is the portable smoke
artifact; DEB covers Debian/Ubuntu. Application ZIPs can be
cross-built, while DMG creation, signing, notarization, and the final smoke test
run on macOS. Every package consumes only the verified `electron-renderer`
artifact and separately compiled Electron host.

The explicit macOS preview command is a local QA contract, not a distribution
artifact. It writes below `release/preview`, uses product name `OpenCraft
Preview`, Bundle ID `dev.opencraft.workbench.preview`, and the independent
`OpenCraft Preview` application-state profile. It disables certificate discovery,
prunes foreign-platform `node-pty` prebuilds from both packaged runtime trees,
and applies one consistent ad-hoc hardened-runtime signature and entitlements
to the Electron helpers and outer app before ZIP creation. Release ZIP/DMG
commands retain their Developer ID and notarization responsibilities.

The GitHub `macos-release` Environment owns these secrets; values must never be
committed or printed:

- `MACOS_CERTIFICATE_P12_BASE64`
- `MACOS_CERTIFICATE_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`

The release job imports the Developer ID into an ephemeral keychain, deletes it
in an `always()` cleanup step, verifies the Universal slices,
Developer ID signature, stapled notarization ticket, Gatekeeper assessment,
DMG signature/image and ZIP integrity, then emits SHA-256 checksums. The final
signed DMG is separately submitted to Apple; only an `Accepted` result permits
stapling. Its ticket and Gatekeeper assessment must pass before checksums and
artifact upload. The same final-DMG smoke test copies the app to an isolated
profile, checks its real renderer and retains logs/a screenshot as
`opencraft-macos-universal-smoke-<sha>` for three days. Only the final DMG,
app ZIP and their checksums are delivered;
intermediate update metadata/blockmaps are not published by this workflow.

The standalone signing process queues file opens before loading the signer, so
its concurrent resource inspection cannot exhaust macOS file descriptors.
After Apple accepts an app or DMG, transient ticket-delivery failures retry
with bounded backoff without resubmitting the artifact. Rejected submissions,
exhausted retries and failed ticket validation still fail the release.

To provision the Environment, use GitHub **Settings → Environments →
macos-release → Environment secrets**, or `gh secret set --repo
opencraft-app/opencraft --env macos-release NAME` with the value on standard
input. The certificate must be a Developer ID Application identity exported with
its private key as password-protected PKCS#12. Apple Development certificates
cannot substitute for it. `APPLE_APP_SPECIFIC_PASSWORD` is an app-specific
password for the Apple ID authorized to notarize for `APPLE_TEAM_ID`; it is not
the account login password. Store credential files outside the repository and
never pass their contents as shell literals or include them in logs. Missing
credentials leave the release blocked; do not fall back to ad-hoc signing.

The Electron host never loads the application with `file://`, but its loopback
server is only a static asset owner. Renderer App Host frames cross a transferred
`MessagePort`; Electron Main relays those frames over authenticated local IPC to
the separately bundled OpenCraft Daemon. Only the daemon starts the pinned DSH
runtime, local Agent AppServer and physical transports. The desktop build has no
`/appserver` proxy or `OPENCRAFT_APPSERVER_URL` fallback.

For isolated Skills acceptance, set `OPENCRAFT_SKILLS_DIRECTORY` alongside
`OPENCRAFT_MODEL_STORAGE_DIRECTORY` and a fresh `--user-data-dir`. Main forwards
the Skills root through the daemon's `--skills-directory` option to the local
Host. Omission retains `~/.opencraft/skills`; changing the model/profile directory
alone does not isolate Skill writes. `scripts/skills-desktop-fixture.ts` seeds
only a synthetic loopback model and temporary roots for manual desktop QA.

The `web-browser` artifact does not contain the local Host, DSH, Node APIs, or
a native Host process. Its `/appserver` endpoint is owned by the deployment
gateway and may route to a cloud Host. This is a packaging boundary: desktop
ships the Agent next to the application; Web ships only the AppServer client.
Generic OpenCraft Web bundles the built-in Agent settings views and activates
them from website runtime configuration. Managed websites inject Host definitions
and plugin switches into HTML before startup, derived from primary/Codex proxy
targets; the HyperNode plugin is disabled to avoid a second primary Host. No deployment `VITE_*` variables are required for
`package:web:server`. `VITE_APPSERVER_HOSTS_JSON` remains an explicit development
and test override; Agent/HyperNode flags can override activation. Static/Vite
pages without injection retain their old defaults. The downstream product excludes the
built-in Agent and HyperNode plugins; Electron Host ownership is unchanged.
These settings views do not bundle an execution engine.
Host definitions may use root-relative WebSocket paths such as `/appserver` and
`/codex-appserver`. The browser resolves them against its current HTTP or HTTPS
origin, so one Web build works behind both authenticated entry points.

### Docker Compose

The Linux ARM64 container entry is maintained in [`docker/`](../docker/README.md).
It packages the Headless gateway and exports matching native Codex/Pi execution
owners for the host, with independent bind-mounted data and workspaces. The
container build is separate from the single-owner archive target below.

### Headless Linux server archive

`headless-linux-amd64-tar` builds a separate single-owner server artifact from
the same OpenCraft sources. It bundles a pinned Node executable, the DSH runtime,
an exact-version Linux amd64 Codex CLI, native Linux PTY module, Web renderer
and a Node launcher. It does not contain
Electron Main, Preload or window dependencies. The Web renderer seeds one
same-origin `Server` Host profile; the launcher starts the actual
Local Agent Host and proxies `/appserver` to its private loopback endpoint.
The same loopback gateway exposes `/apphost` for a leased Codex Host, backed by
the existing OpenCraft Codex stdio adapter and account pool. Web Settings
reuses Model Services for DSH and Codex Accounts for user-initiated device-code
sign-in. Credentials stay in the server data directory, not browser storage.
Neither engine logs in automatically; a fresh installation needs a configured
DSH model or a permitted Codex account before it can submit a task.

Codex queued-message Steer is implemented in the Host-owned durable queue and
uses stock Codex `turn/steer`; no patched Codex binary is bundled. The server
data-directory lock is the single-owner boundary for queue migration and
dispatch. Do not share its Codex data directory with another independent
AppServer process. The package smoke checks the Host queue capability rather
than a native patch marker.

Build on a native Linux amd64 machine with the checked-in Node version and
installed dependencies. `release/OpenCraft-server-0.1.0-linux-amd64.tar.gz`
must pass `npm run smoke:headless:linux` for both DSH and Codex initialization
before distribution. GitHub's portable
matrix produces and smoke-tests this archive as an Actions artifact; a PR build
is not a published release.

The headless archive must contain a Web release built with
`OPENCRAFT_HEADLESS_SERVER_BUILD=true` and the `opencraft-server` `/appserver`
Host profile. Its `web/version.json` records that delivery target; packaging,
package smoke, and server startup reject a generic `build:web` artifact. A
successful Codex process start alone does not prove the Web Codex entry was
included. Do not copy an existing generic `dist` into a headless archive.

```sh
tar -xzf OpenCraft-server-0.1.0-linux-amd64.tar.gz
./opencraft-server/bin/opencraft-server --port 10000 --data-dir /private/opencraft-data
```

The startup command prints the local WebUI URL. The listener defaults to
`127.0.0.1`; browser WebSockets must have the matching Origin, and the gateway
never exposes its upstream Host token in health output. For a browser on your
own computer, use a trusted SSH tunnel, for example
`ssh -L 10000:127.0.0.1:10000 user@server`, then open
`http://127.0.0.1:10000`. The data directory must be private (mode `0700`).
Public binding requires both `--host 0.0.0.0` and
`--allow-unauthenticated-public`; static WebUI and `/appserver`/`/apphost`
WebSockets then share the chosen port with same-origin checks. This is one
single-user Host, not multi-user authorization, HTTPS termination or a secure
cloud deployment. Downstream account login is not a substitute for
server access control. Two server processes cannot own the same data directory.
For a restricted systemd preview, set a private `StateDirectory` and its
`HOME` to that directory for the service user; the launcher puts its single-
writer lock inside the data root so `ProtectSystem=strict` can remain enabled.

For an operator-requested persistent, unauthenticated HTTP installation, run
the separate repository tool `scripts/install-headless-linux.sh` on the Linux
host. It consumes a newly built tar and its trusted SHA-256, installs a
`DynamicUser` systemd service with `Restart=on-failure` and `enable --now`,
binding OpenCraft directly to `0.0.0.0:80` by default. The static WebUI and both
WebSocket paths run on that same port: there is no Nginx or second proxy.
The tool is not part of the desktop executable; the server runtime retains its
private default. It refuses occupied ports, an existing installer unit,
checksum mismatch and unsafe archive entries. It never
stops an existing preview or copies account data automatically.

```sh
sha256sum release/OpenCraft-server-0.1.0-linux-amd64.tar.gz
sudo ./scripts/install-headless-linux.sh \
  --archive release/OpenCraft-server-0.1.0-linux-amd64.tar.gz \
  --sha256 '<verified 64-character digest>' \
  --port 80 \
  --state-name opencraft-server \
  --allow-unauthenticated-public
```

The danger flag is an acknowledgement, **not access control**: every client
that can reach that port can use the shared Codex accounts and Host file/
terminal capabilities. There is no TLS or login, so do not treat this as a
public multi-user deployment. To reuse an existing state directory, pass its
exact `StateDirectory` name and stop its current owning service first; the
single-writer lock prevents concurrent owners. Use `--render-dir <empty-dir>`
to inspect the unit without root or server changes. A previous tar
does not acquire source fixes merely because a running preview bundle has them.
For ports below 1024, the unit grants only `CAP_NET_BIND_SERVICE` so its
DynamicUser can bind without root or a system-wide sysctl change.
Ordinary remote HTTP is not a browser [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Secure_Contexts). The Web entry installs a
[`getRandomValues`](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues)-backed UUID fallback for core drafts and conversations;
secure-context-only browser features such as Service Worker-backed browser
proxying, microphone and modern clipboard are not promised in this mode.

## macOS Developer ID 签名包运行手册

仅在用户授权本地打包/签名后执行。打包不隐含安装、提交或远端发布。
`beforePack` 要求原生目标 OS/架构与构建机一致，不能把本机 DSH 原生依赖复制成另一架构的可运行包。

### 构建与身份

在 `opencraft/` 核对分支、dirty 状态和目标架构，记录本次是否包含未提交修改；
运行相关验证后重新执行 `npm run build:electron`。不能只重用上次 Renderer 或 Daemon 输出。
从 `apps/workbench-web/dist-electron/version.json` 读取本次 buildId，不以 `0.1.0` 等版本号判断包是否最新。

```sh
rtk proxy security find-identity -v -p codesigning
rtk proxy uname -m
rtk proxy npm run build:electron
```

以下例子在 `opencraft/apps/workbench-electron/` 执行。先将 `signing_identity` 替换为本次已验证的
Developer ID 身份名称（electron-builder 的 identity 选项使用姓名/团队部分，不加证书类型前缀）。
`arm64` 只适用于 Apple Silicon 原生构建机；Intel 目标在原生 Intel 构建机上使用 `x64`。

```sh
signing_identity="已核验的姓名与团队标识"
signed_output="release/signed-$(date -u +%Y%m%d-%H%M%S)"
rtk proxy env -u CSC_IDENTITY_AUTO_DISCOVERY -u OPENCRAFT_MAC_PREVIEW \
  ../../node_modules/.bin/electron-builder --mac dmg zip --arm64 --publish never \
  --config.directories.output="$signed_output" \
  --config.mac.identity="$signing_identity" \
  --config.forceCodeSigning=true --config.dmg.sign=true
```

保留项目现有 hardened runtime、entitlements、beforePack 与 afterPack。
afterPack 只在新组装的包中整理目标架构 PTY 并修正 helper 执行权限；不修改用户安装版。
签名可能逐个处理大量内嵌资源。等待期间检查当前子进程/日志是否推进，不凭持续时间认定卡死，
也不要把仍在生成的 ZIP/DMG 当成最终制品。

### 签名不等于公证

Developer ID 证书允许签名，但不会自动提供 Apple 公证授权。读取凭据配置时只报告存在性，
不打印密钥、密码或 token。若使用钥匙串 profile，必须先确认其实际名称；
找不到某个 profile 或环境变量为空，不代表机器上所有公证凭据都不存在。

当前 electron-builder 支持 Apple ID、App Store Connect API 或明确的 keychain profile 配置。
日志中的 `skipped macOS notarization` 是缺失的交付步骤，不是公证成功。
只有实际提交获得接受结果、完成对应票据处理并通过验证后，才能报告公证完成。
如果后续公证/重签改变 `.app` 或 DMG，需重新封装对应制品、生成 blockmap 和最终 SHA-256。

### 最终制品验收

将下列参数替换为本次最终制品的明确路径，不指向旧 `release/mac-arm64` 或 `/Applications`：

```sh
rtk proxy codesign --verify --deep --strict --verbose=2 "$signed_app_path"
rtk proxy codesign -d --verbose=4 "$signed_app_path"
rtk proxy codesign --verify --verbose=2 "$signed_dmg_path"
rtk proxy hdiutil verify "$signed_dmg_path"
rtk proxy unzip -t "$signed_zip_path"
rtk proxy spctl --assess --type execute --verbose=4 "$signed_app_path"
rtk proxy shasum -a 256 "$signed_dmg_path" "$signed_zip_path"
```

- 核对实际签名 Authority、TeamIdentifier、架构、hardened runtime 与时间戳。
- `spctl` 若返回 `Unnotarized Developer ID`，保留拒绝结果并告知用户；不能用签名校验通过覆盖它，也不关闭系统安全机制。
- 比较包内 `renderer/version.json`、`runtime/opencraft-daemon.cjs` 与 DSH 插件脚本和本次构建，记录构建来源与 SHA-256。
- 启动包内真正的 `Contents/MacOS/OpenCraft`，清除 `ELECTRON_RUN_AS_NODE`，使用全新 user-data-dir、模型存储目录和空闲调试端口。仅隔离 user-data-dir 不会隔离默认的 `~/.opencraft` 模型配置。
- 在该签名进程中验证首页、相关导航与本次修改。不得复用旧源码预览的结果冒充包体验证，不登录或发送付费请求来做默认烟测。
- 输出说明分别列出：源码/dirty 状态、buildId、App/DMG 签名、公证/Gatekeeper、完整性、启动/功能验证、未通过门禁，以及是否安装或发布。一次能启动不等于完整分发资格。

## Linux browser smoke prerequisites

### Trusted internal desktop deployment

For an installation where every network-admitted user is trusted to view this
machine's desktop, choose `--trusted-internal-desktop` instead of `--local-desktop`.
Keep the existing `--host 0.0.0.0 --allow-unauthenticated-public` acknowledgement
for a non-loopback listener. No enterprise service or separate account service is needed. The
verified native observer must already be installed/running; legacy interactive
VNC/noVNC ports need not be started or exposed. A TLS reverse proxy must preserve
the browser-facing Host and forward `/desktop/connect` WebSocket upgrades.
Open an existing local Codex conversation, then select Desktop in the right-panel
toolbar. It is observe-only, and closing it does not stop Agent work or the desktop.
For mouse/keyboard control, additionally install the root-owned helper/unit from
`apps/local-agent-host/native/linux/` and explicitly start
`opencraft-desktop-control.service`, then add `--desktop-control`. The server
must run as the trusted root backend peer. It fails startup if the verified input
executor does not match the observer incarnation. The unit opens no TCP listener;
neither mode requires enabling legacy interactive VNC/noVNC. Users still must
click Take control, and only one viewer can control the shared machine. Closing
or leaving releases it; refresh/recovery returns to viewing. Clipboard paste is
not included in this local input capability.

From the extracted server package, after the verified observation services are
already installed, the operator can install the optional input service explicitly:

```bash
sudo install -o root -g root -m 0755 runtime/native-desktop/desktop-control.py /usr/local/libexec/opencraft/desktop-control.py
sudo install -o root -g root -m 0644 runtime/native-desktop/opencraft-desktop-control.service /etc/systemd/system/opencraft-desktop-control.service
sudo systemctl daemon-reload
sudo systemctl start opencraft-desktop-control.service
```

Updating an already-running input helper requires an explicit service restart;
that revokes active input. The main OpenCraft service is not restarted by installation.
Default installations remain hidden. This explicit network-trust mode is not a
multi-tenant or anonymous Internet deployment; see the
[authority boundary](cloud-desktop-plugin.md#local-execution-server-authority).
`OPENCRAFT_DESKTOP_ACCESS=trusted-internal npm run smoke:local-desktop` verifies
the same real native/Thread chain at a non-loopback browser hostname with
isolated synthetic inference, including viewing recovery and disabled input.
It uses the already-running desktop rather than recoloring its root window.
Explicit Codex/browser tools must exist before the smoke creates any resources.
Add `OPENCRAFT_DESKTOP_CONTROL=true` to that smoke to verify real mouse/key
delivery in a self-owned native test window, physical mutual exclusion, renewal,
Unicode mapping, forced key release and no control reacquisition after recovery.

浏览器二进制存在不代表本机可以启动。Linux 浏览器验收在创建测试资源、启动模型/Host 和
桌面连接前，必须检查**实际选定的 Chromium**及它运行时使用的系统库环境：

```sh
ldd "$OPENCRAFT_CHROMIUM_EXECUTABLE"
```

项目复用 `scripts/browser-smoke-preflight.mjs` 的 `assertBrowserRuntimeDependencies`，列出
所有 `not found` 库并失败退出，不自动安装、不绕过检查、不把失败算成 UI 验收。
`smoke-cloud-desktop-rfb.ts`、`smoke-desktop-panel-ui.ts` 和 `smoke-local-desktop.ts` 已调用此检查。工具路径用明确的
`OPENCRAFT_PLAYWRIGHT_MODULE` / `OPENCRAFT_CHROMIUM_EXECUTABLE` 注入；不得复制别的
checkout 的 node_modules 或把一次性工具缓存路径固化为应用依赖。

TencentOS 4.4 本机验收曾缺少 `libgbm.so.1`、`libasound.so.2`；补齐或引入这两者后，
`libgbm` 还会暴露下游缺失的 `libwayland-server.so.0`。所以不能只修第一次启动报错：
必须对 Chromium 和新增库的传递依赖重新运行检查。当前 TencentOS 仓库分别提供
`mesa-libgbm`、`alsa-lib`、`libwayland-server`（安装前核对本机发行版和仓库）。
Ubuntu/Debian 继续使用自己的发行版依赖安装方法，不给现有 Ubuntu 安装分支混入 DNF 命令。

如果已有隔离浏览器工具库，可以仅对验收进程设置明确的 `LD_LIBRARY_PATH`；这不是应用的
安装依赖，也不应修改系统全局搜索路径。记录最终 Chromium、库来源、缺失项、修复命令和
实测结果；执行环境仍不满足时，应报告“浏览器验收未完成”，不能用构建/单测替代。

本机桌面全链路烟测使用 `scripts/smoke/desktop/smoke-local-desktop.ts`：显式提供上述工具路径和
`OPENCRAFT_CODEX_EXECUTABLE`，先准备独立只读观察服务；在验收拥有的 Xvfb `:1` 上设置
已知根窗口颜色 `#2080e0`，然后核对真实 Codex Thread、观看授权、1440×900 的原生 RFB
画面及像素。推理只访问独立的本地合成端点，不复制真实凭据/会话。服务原状态、隔离
profile 和截图路径保留在本次 Task receipt；结束后恢复本次启用的服务，不重启聊天预览。
应先启动 observer 保持 X 客户端连接，再设置已知根窗口颜色；最后一个 X 客户端退出会
触发 Xvfb reset，若先着色后再启动 observer，颜色可能变回黑色，不能将此归因于传输。
脚本只断开自己创建的一条 native 观看流，核对有限自动恢复后的新 canvas/像素和独立新连接；
不停止桌面服务、不切断聊天连接，也不重新请求模型。这不是手机真实弱网验收。
验收页必须消费当前 checkout 构建的正式 CSS 和应用使用的主题生成属性；仅设置
`data-theme` 不会生成全部语义颜色，连接背景/按钮描边可能透明，不能用几何通过替代视觉验收。
`npm run smoke:desktop-panel` 验证真实面板在三个主题及 720px/320px 中的完整状态与短文案，
后端/媒体是明确的合成边界；真实 noVNC 和本机权限分别由另外两项烟测验收。
脚本还检查实际画布可见尺寸及其在面板内的完整显示，并保留截图复核，拒绝零面积画面。

## Managed Web release package

`OPENCRAFT_RELEASE_VERSION=<exact-version> npm run package:web:server` builds
`web-browser` and packs `@opencraft-app/opencraft` with the static site, bundled
Node runtime, a systemd template and installation instructions. The package has
no install lifecycle scripts or runtime npm dependencies. It does not package or
manage DSH/Codex. Build output defaults to ignored `.local/web-packages`. This
command never publishes; validate the tgz before publishing to the public npm
registry. Run `npm run test:web-updates` for registry/package/worker update and
rollback behavior, alongside `npm run test:web-release`.

For requests to “发布 npm”, follow the
[public npm release procedure](web-deployment.md#公共-npm-发布流程),
including explicit source revision, credential reuse, exact-archive publication,
registry download verification and the real website Playwright check.

Managed Web installs expose Settings → Website updates after the actual server
capability is confirmed. Plain static hosting and Electron retain their own
delivery paths. See [Web deployment](web-deployment.md) for the bootstrap,
public npm access, supported hot-update scope and browser refresh.


### Downstream identity verification

The public workspace has no enterprise identity package dependency or private test command. A
product that selects an enterprise factory owns its package installation, type
checks, catalogs and integration tests before invoking the public build tools.
Core tests continue to verify generic authorization with a signed synthetic
provider; replacing a verifier must not remove authorization coverage. Building
a default artifact still proves only its actual transitive graph, not the
independence of the remaining downstream or native product code.

### Downstream public assets

`OPENCRAFT_PRODUCT_PUBLIC_DIR` explicitly selects a trusted local product public
directory, relative to the core workspace or absolute. Default core builds select
none. The adapter preserves original filenames/bytes and rejects missing roots,
symlinks and core/generated-output collisions. Vite development and preview serve
the same URLs; native `copyPublicDir: false` builds continue to omit these files.
The downstream product runner owns `build:web`, `build:web:release` and
`build:embedded:release`, choosing its existing entries and `products/<product>/public`.
Private product build aliases run downstream. The managed site's fixed
source packaging selects the same product assets when the selected revision owns
that directory; historical receipts retain their original core public layout.
This neither deploys the downstream product nor resolves the artwork's distribution rights.

### Expo product selection

The public mobile entry always selects the packaged full
Web Workbench container for public Expo commands. The runner builds its local
document before Metro. This is the only public mobile entry; it neither selects a private
product nor proves native-device parity. See
[container ownership and acceptance](mobile-workbench-container.md).

Default Expo Web/iOS bundle commands build the packaged Web Workbench with its
configured direct Host. An account-gated downstream Router is selected through
`products/<product>/run-expo.cjs`; product-owned APK/IPA and agents-next aliases explicitly delegate
to it so Metro, Gradle and Xcode inherit the same local product entry/config.
All downstream product platform entries use its frontend-generated Bot HTML;
math/Mermaid rendering is part of that shared packaged document. This selection does not
claim signed builds, physical plugin extraction or device verification.


## Headless smoke process ownership

The Linux archive smoke starts its server in a new process group owned only by
the harness. Teardown signals that group, waits for the server's `close` event
(with the existing five-second forced-stop deadline), and stops residual children
before removing its temporary data. This covers background plugin clones after
the leader exits. Bounded filesystem retries handle pending directory removal;
errors still fail the smoke. No existing service or unrelated process is signaled.
`tests/server/headless-smoke-process.test.mjs` verifies an orphan writer stops, an
unrelated process survives and a nonresponsive leader is actually killed. The
existing `test:headless-server` command includes these regressions, so both the
Linux CI job and the complete core gate execute them.

## Copied image optimization

Web delivery optimizes copied top-level JPEG, PNG and WebP assets using the
locked Sharp dependency. Original source assets and URLs remain unchanged.
Output keeps its format, applies orientation before the existing 1280px bound,
and replaces an asset only when its encoded bytes are smaller. Small PNGs
retain their pixels and alpha. Corrupt supported images fail the build.
`test:web-release` exercises these contracts and the raw RGBA API also used by
the mobile sidebar screenshot probe; dependency upgrades require both Node
build/release runtimes and actual copied delivery-asset verification.

### Linux remote-browser payload

Both `package-headless-linux.mjs` and managed headless `package-web-server.mjs` ship `runtime/browser` using `package-browser-runtime.mjs`, including Electron licenses. Build on native Linux using the workspace-pinned Electron distribution. The independent browser worker does not start the desktop application. See [managed headless](managed-headless.md#内置远程网页渲染) for sandbox, dependencies and profile ownership. `npm run smoke:remote-browser` exercises the real typed Dynamic Tool Host, Page/Presentation and H.264 Canvas on Linux; it uses a synthetic website and does not prove macOS behavior or physical-device input.


Optional Session history refresh, older-page projection and tail-drain handling
are demand-loaded from `packages/appserver-session/src/derived-history.ts`.
The startup-resource policy rejects this module in the required bootstrap graph;
initial Thread baseline and cancellation admission remain in the Session core.
Both ordinary hidden-map builds and release builds retain their existing asset
naming, minification, startup byte limits and separate browser compatibility checks.

## Full-runtime packaging cache

On Linux x64, `OPENCRAFT_PACKAGE_CACHE_DIR` optionally reuses assembled Codex/DSH
runtime dependency closures. Keys include pinned manifests/locks, transformation
and patch sources, Node/ABI, platform, architecture and libc. Cached payloads
are copied to independent files and their complete inventory, SHA256 and modes
are verified before use; a missing or invalid entry rebuilds normally. The
cache is trusted build infrastructure and must only be writable by the build
owner. Remove its directory while idle to force a cold build.

Core and release identities, provenance, signing, final compression and archive
verification are generated for every release. `OPENCRAFT_PACKAGE_TIMINGS=1`
emits inventory, npm-pack and archive-verification durations to stderr; runtime
cache messages report hit/miss duration. The JSON packaging result is unchanged.

### Single-selection streamed full-release archives

Signed full releases reserve their two signature metadata paths before running
npm's installed `npm-packlist` rules once. The manifest and signature replace
those placeholders in that same staging transaction; the selected names and
npm's original tar options/order then drive a streaming archive writer. Default
gzip level 9 produces the same bytes as `npm pack`, including bin modes and
bundled dependencies, without a second selection or a whole-archive buffer.

`OPENCRAFT_PACKAGE_GZIP_LEVEL` accepts integers 1–9, default 9. A lower level
trades larger transfers for less compression CPU. Signing, exclusive release
identity, archive budgets and the final independent archive verification still
apply. Changing compression for an already completed release cannot overwrite
its bound integrity. Signed content inventories are always rebuilt per release.

When `OPENCRAFT_PACKAGE_CACHE_DIR` is set, npm selection can reuse unchanged
top-level directories. The key covers their names/types/link targets, every
package/ignore/lock policy file in the staging tree, and npm/Node/toolchain identity.
Only the root package version, `opencraftWeb.buildId` and `opencraftFullRelease`
identity are normalized; ordinary file contents are still hashed on every build.
Changed directories use the original npm walker; root manifests and ignore files
are always processed. External or broken links disable reuse, and a damaged cache
causes a fresh scan. No npm/minimatch prototypes or matching rules are modified.
`[package-selection]` reports reuse and elapsed time. Removing the cache restores
cold selection; this cache never replaces signing or independent archive checks.
