# Human TUI reproducible build design

Date: 2026-08-17

## Goal

Make the Human TUI a first-class, reproducible `vela-computer` release artifact. Restore its missing source entry,
ReactVaxis renderer, terminal presenter and build command in the repository. Every Computer release must prove that
the embedded bundle was generated from the current shared JavaScript application source.

The rebuilt TUI preserves the existing login, Server switching, chat, members, Agent, Computer, task and first-time
setup surfaces. It consumes the same AppStore and semantic page models as the graphical client, so Channel
membership JIT compensation and future application behavior are implemented once in JavaScript.

## Current failure

`agent/internal/vela/humantui/assets/human-client.bundle.js` is a checked-in minified artifact last updated on
2026-08-04. The repository contains no source entry or command that can reproduce it. Building a new Go binary
therefore embeds an old application even when `web/apps/client` changed.

The current TUI proves the drift: `general` is displayed as joined, Topic history fails with `sdk_10007`, and the
old application does not invoke the shared JIT membership ensure flow.

## Source ownership

Add a terminal-only source tree under `web/apps/client/src/tui/`:

```text
src/tui/
  entry.tsx
  native-modules.ts
  navigation.tsx
  presenter.tsx
  primitives.tsx
  renderer/
    host-config.ts
    node.ts
    reconciler.ts
    registry.ts
```

Responsibilities:

- `entry.tsx` creates the canonical AppStore, terminal route host and `PresentationProvider`, then exports
  `globalThis.__velaTui` with protocol `reactvaxis/v2`, `start`, `dispatch` and `resize`.
- `native-modules.ts` implements the platform and messaging ports on top of `__velaNativeModules`. It owns bridge
  request IDs, deadlines, subscriptions and conversion of structured Native errors into client-core errors.
- `navigation.tsx` owns terminal-local navigation state. It does not import Expo Router or browser location state.
- `presenter.tsx` renders existing `ConversationPageModel`, `ManagementPageModel` and `WorkspaceSetupModel` values.
  It does not derive product permissions, membership or lifecycle state.
- `primitives.tsx` exposes the finite ReactVaxis host vocabulary used by the presenter.
- `renderer/` owns React 19 reconciliation, immutable NativeNode serialization, handler registration and commit
  publication.

The TUI source may import the canonical AppStore, shared screen/presentation model builders and client-core. Its
transitive dependency graph must reject Expo Router, DOM, browser storage, the Tencent Web SDK and Web-only UI
adapters. HTTP credentials and LiteChat/Tencent transport remain behind Go Native Modules.

The current semantic dependency graph is not yet terminal-pure: `ui/presentation/management-shell.ts` reaches
`ui/layouts/workspace-section.ts`, which carries graphical icon components. Before the TUI imports it, extract the
section IDs, labels, permissions and action builders into a terminal-safe module containing data and callbacks only.
The graphical adapter maps those IDs to Lucide icons. Stubbing icons, allowing React Native through the TUI build,
or duplicating navigation answers in `src/tui` is forbidden.

## ReactVaxis renderer contract

The renderer supports the existing Go `NativeNode` contract, including:

- layout nodes: View, Text, ScrollView, VirtualList and Overlay;
- controls: Button, TextInput, Checkbox and Segmented;
- application structure: NavigationStack, route keys and back/dismiss handlers;
- presentation fields: labels, values, placeholders, disabled/selected/busy state and progress;
- layout style: direction, dimensions, padding, gap, alignment, border, flex and semantic surface;
- controlled input event-count acknowledgement.

The React 19 host config is a mutation renderer (`supportsMutation=true`, `supportsPersistence=false`,
`supportsHydration=false`). Its private root container owns ordered host children, viewport width/height and the
commit callback. Host instances and raw-text instances are mutable reconciler implementation objects; raw text is
valid only beneath the Text primitive. No reconciler object crosses the Go boundary.

`start()` creates one ConcurrentRoot container and calls `updateContainer` with the application element. React
mutations update the private host tree. `resetAfterCommit` is the sole publication point: it walks the committed
tree, produces a new plain NativeNode snapshot, calculates the exact set of mounted handler IDs, prunes all older
handlers, and calls `__velaNative.commit(snapshot)` once. Publication never occurs from individual mutation hooks.
Persistence cloning, hydration, portals, Suspense host hiding and offscreen host mutation are deliberately
unsupported in v1 and must fail or remain unused rather than invent partial semantics.

Every interactive callback receives a stable handler ID from a renderer-owned registry. `dispatch(handlerId,
payload)` resolves only currently mounted handlers. Unmounted handlers are removed on commit, so a delayed terminal
event cannot invoke a stale screen. `resize(width, height)` updates a terminal viewport store and schedules a React
render.

Controlled TextInput dispatch carries `eventCount`; the rendered value acknowledges it through
`mostRecentEventCount`. A commit with an older count cannot overwrite the native buffer. Handler identity stays
stable while the same mounted prop callback remains reachable and changes when the callback or host instance is
replaced.

Each committed React tree is converted to plain data and passed to `__velaNative.commit(tree)`. No JavaScript
object, closure or credential crosses the commit boundary.

## Native error boundary

Business decisions remain in JavaScript.

- Go IM transports continue to expose safe provider diagnostics such as `sdk_10007`.
- `reactvaxis/nativemodule` recognizes only a strict safe-code form (`sdk_` followed by 1-10 decimal digits). For
  such an error it emits `providerCode` and replaces the human-readable message with a fixed product-neutral
  message. Raw provider text, URLs, opaque values and the original error string do not cross into JavaScript.
  Go does not translate the code to `IM_NOT_MEMBER` and never starts membership repair.
- The TUI JavaScript MessagingPort interprets `providerCode=sdk_10007` only in a Topic-history operation and throws
  `PlatformError(IM_NOT_MEMBER)` while preserving the provider code.
- The shared JavaScript AppStore owns JIT ensure, Operation polling, single-attempt protection, navigation fencing
  and reconnecting UI.

Other commands and provider codes remain unchanged. String matching against `LiteChat 命令被拒绝` is forbidden.
Regression fixtures include a secret-like provider message and prove it is absent from the Native rejection while
`providerCode=sdk_10007` remains present.

## Deterministic build

Add `web/apps/client/tools/build-human-tui.ts` and package commands:

```text
bun run build:tui
bun run check:tui
```

`build:tui`:

1. bundles `src/tui/entry.tsx` as one minified IIFE for a browser-like ES runtime without DOM globals;
2. uses the repository-pinned Bun workspace and `web/bun.lock`, a fixed target, no source map, timestamp or absolute
   source path;
3. rejects unresolved externals and forbidden dependency families;
4. writes the bundle, SHA-256 file and a versioned manifest atomically into
   `agent/internal/vela/humantui/assets/`;
5. records protocol, bundle digest, sorted transitive source inputs and their aggregate source digest.

The manifest schema is `vela-human-tui-build/v1`. Paths are slash-normalized and relative to the Git repository
root. The source input set is defined exactly as:

- every Bun metafile input inside `web/apps/client/src/` and `web/packages/client-core/src/`;
- the builder script and relevant tsconfig files;
- `web/package.json`, both participating workspace `package.json` files and `web/bun.lock`.

Any source input outside those allowed roots fails the build. `node_modules` file paths are not recorded; dependency
resolution provenance is the exact `web/bun.lock` digest plus package manifests. Inputs are sorted by normalized
path, each file is hashed as raw bytes, and the aggregate source digest hashes a versioned length-prefixed sequence
of path and content digest. Manifest JSON uses fixed key order, UTF-8 and one trailing newline. Two clean builds in
different temporary directories must be byte-identical, including the manifest.

`check:tui` builds into a private temporary directory and byte-compares all three tracked artifacts. It never
rewrites the workspace. Missing source, nondeterministic output, stale bundle, hash drift or manifest drift fails.

The generated bundle remains checked in because the Go Agent tree is copied independently to the Linux Buildx
builder. The bundle is derived, but its derivation is now reproducible and mandatory.

## Computer release integration

`backend/scripts/deploy-computer-canary.sh` adds a required absolute `--web-source` argument whose value is the
checkout's `web/` directory. `--agent-source` remains the checkout's `agent/` directory. After physical path
resolution, the script requires both paths and its own `backend/` directory to share one `git rev-parse
--show-toplevel` result and one HEAD. Symlinked or cross-checkout source roots are rejected.

Before Agent tests or either target build, the Mac release host invokes `check:tui` from
`$web_source/apps/client`, passing the explicit Agent source output root. Bun is a required release tool. The remote
Linux builder receives only the already verified Agent tree and does not install Node or Bun.

Release order:

1. validate Git/source inputs and run `check:tui`;
2. run Web TUI source tests and Agent Human TUI headless tests;
3. build darwin-arm64 and linux-amd64 from the same verified Agent tree;
4. sign and publish the immutable dual-target Release Set;
5. upgrade through the existing installer/catalog flow.

The release evidence records TUI bundle and source digests. `AGENTS.md` and release-script tests are updated with
the required `--web-source` usage. A standalone Agent build may compile an already verified checked-in artifact,
but the formal Computer release cannot bypass the Web source check.

## Compatibility and acceptance

Existing Go headless bundle tests remain the functional compatibility oracle and must continue to prove:

- canonical login;
- session restore into chat;
- first Server setup;
- Agent, Computer, member and task navigation;
- terminal forms, selection and event dispatch;
- narrow-terminal remediation.

The current suite does not yet cover every item in that list. Add explicit bundle tests that switch between two
Servers, open and submit at least one management form through ReactVaxis dispatch, change a segmented/selection
control, reject a stale handler after navigation, and render the less-than-100-column remediation. “Existing tests
pass” alone is not sufficient for full-behavior compatibility.

Add tests for:

- renderer create/update/delete, stable handlers, stale-handler rejection, resize and controlled input;
- Native Module provider-code preservation without Go semantic translation;
- TUI adapter maps `sdk_10007` only for Topic history;
- deterministic double-build produces byte-identical bundle, SHA and manifest;
- `check:tui` detects a stale tracked artifact;
- Computer release rejects missing/relative Web source and stale TUI;
- headless TUI JIT scenario: first Topic history returns `sdk_10007`, exactly one existing membership ensure is
  submitted and polled, history succeeds on retry, and reconnecting state disappears;
- second rejection and navigation during repair do not loop or reopen stale state.

The final local acceptance uses a newly built Computer against a controlled HTTP/IM fixture before any live
upgrade. Live DevCloud acceptance occurs only after Backend deployment and Computer release are explicitly
authorized.

## Security

- The bundle is local, immutable and SHA-verified before Goja execution.
- No remote bundle URL or runtime code update is introduced.
- Credentials remain in Go-managed storage and Native Modules; the source manifest contains paths/digests only.
- Build and check commands never print bundle contents, credentials or absolute secret paths.
- Existing provider diagnostics remain redacted before entering the Native error envelope.

## Non-goals

- downloading or hot-swapping TUI code at runtime;
- moving membership compensation into Go;
- using the old minified bundle as source;
- reducing TUI to chat-only behavior;
- adding a second AppStore or terminal-specific business state machine;
- requiring Docker on the Mac release host.
