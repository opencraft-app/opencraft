# OpenCraft Harness design charter

## Status and intent

This document is the project-level authority for OpenCraft's executable behavior
verification architecture. It defines what a Harness is, where scenarios live,
how runners and platform adapters cooperate, which evidence a run must produce,
and which invariants gate changes.

The Harness is not a second product implementation and is not a collection of
screenshots. It is a controlled execution environment around production public
interfaces:

```text
fixtures -> production system -> probes -> trace -> invariants -> artifacts
```

Every meaningful OpenCraft subsystem must expose an executable proof seam. It does
not follow that every package needs its own test application. Packages own
their scenarios; a small set of shared runners executes those scenarios in the
environments whose behavior matters.

The words **must**, **must not**, **should**, and **may** in this document are
normative.

## Goals

The Harness must make the following claims reproducible:

1. A renderer-free state machine produces the correct public snapshot and
   command effects under deterministic input.
2. Browser layout, scrolling, focus, selection, measurement, virtualization,
   and streaming behavior hold in a real browser engine.
3. AppServer Resume, pagination, Replica synchronization, reconnect, and fault
   recovery converge to the expected authority state over every supported
   transport.
4. Electron-specific process, WebContents, compositor, window chrome, focus,
   and preload behavior hold in real Electron.
5. Native gestures, safe areas, keyboard behavior, text input, and lifecycle
   hold on a real simulator or device.
6. A failed run leaves enough machine-readable evidence to reproduce and
   diagnose the failure without relying on the original terminal session.

The Harness should also provide an interactive Lab where developers and agents
can select a scenario, inject faults, inspect traces, and compare snapshots.
That Lab is a runner and visualization surface, not the owner of domain truth.

## Non-goals

The Harness must not:

- introduce test-only branches into production behavior;
- duplicate the AppServer, Replica, Timeline, Composer, or renderer state
  machines;
- use screenshots as the primary behavioral assertion;
- use JSDOM or a hand-written fake DOM to approve browser layout behavior;
- hide platform differences behind a lowest-common-denominator node API;
- make Cordis an assertion library or a substitute for typed ports;
- require one central package to know every product-specific action;
- expose credentials, live session contents, or private filesystem data in
  committed fixtures and artifacts.

## Engineering principles

OpenCraft uses the following engineering principles:

- tests prove user-visible or API-visible behavior rather than implementation
  structure;
- deterministic unit tests use injected ports and typed adapters;
- RPC-backed UI behavior is verified through a real browser, network path, and
  isolated daemon where feasible;
- every worker owns its daemon state, ports, storage, projects, and cleanup;
- resource leaks are test failures, not teardown warnings;
- failure, timeout, disconnect, retry, and recovery states are asserted at the
  surface visible to the caller;
- streaming smoothness, React commits, DOM replacement, geometry, and memory
  are measured rather than judged by feel;
- Electron compositor behavior and native gestures are verified in their real
  runtimes;
- failure artifacts are retained automatically.

OpenCraft standardizes the scenario contract,
capability model, trace envelope, artifact manifest, and lifecycle audit while
retaining platform-native runners.

## Conceptual model

### Scenario

A Scenario is a deterministic description of one behavior. It declares its
owner, truth level, required capabilities, fixture seed, actions, invariants,
and artifact policy.

A scenario should be narrow enough that its failure names one behavioral
contract. It may contain multiple phases when the phases are inseparable parts
of the same contract, such as disconnect, offline mutation, reconnect, and
convergence.

### Runner

A Runner selects scenarios, resolves capabilities, owns process lifecycle, and
emits the final result. Initial runners are:

- `apps/appserver-lab`: Node/CLI, NDJSON, protocol and runtime scenarios;
- `apps/harness-lab`: browser UI for discovery, execution, fault controls, and
  trace inspection;
- Playwright: Chromium and WebKit browser execution;
- Electron driver: real main/preload/renderer execution;
- Native driver: iOS Simulator and Android emulator/device execution.

The same scenario may run on more than one runner when its capability contract
is satisfied. A runner must skip only for a declared missing capability; it
must not silently weaken an invariant.

### Driver and adapter

A Driver controls a real or simulated boundary: clock, transport, storage,
browser, Electron, native device, filesystem, or AppServer. Drivers implement
small typed ports. They do not own product policy.

The three AppServer transports remain peers:

```text
MemoryTransport       deterministic in-process frames
ReplayTransport       deterministic recorded frames
WebSocketTransport    real ws/wss frames, including ws://127.0.0.1:9988
```

Recording is a decorator around any transport. Fault injection is a controlled
frame boundary, not a second implementation of the client or server.

### Probe

A Probe observes the system without deciding pass or fail. Examples include:

- protocol frames and request correlation;
- Replica revisions, epoch, journal position, and authority phase;
- runtime snapshots and TanStack Query cache events;
- DOM identity, geometry, focus, selection, scroll, and observers;
- React Profiler commits and render reasons;
- timers, listeners, sockets, object URLs, files, processes, and Cordis fibers.

### Invariant

An Invariant judges trace or live probe data and returns a structured result.
Invariants should be reusable across scenarios. Examples include:

- stable identity was preserved;
- an anchor moved by no more than the allowed physical-pixel tolerance;
- the Composer never intersected the native scrollbar chrome plane;
- no stale connection generation committed state;
- a cached Replica was never presented as authoritative;
- all acquired resources were released;
- streaming growth stayed within smoothness and stall budgets.

### Artifact

An Artifact is evidence, not truth. Each failed run must write a manifest and
all available diagnostics. Successful performance, compatibility, and soak
runs should also retain their structured reports.

## Truth levels

Every scenario declares exactly one truth level:

| Level | Meaning | Appropriate use |
| --- | --- | --- |
| `simulated` | Deterministic typed adapters drive production code | State machines, algorithms, fault matrices |
| `recorded` | Sanitized captured frames or events are replayed | Protocol compatibility, regression reproduction |
| `live` | Real service/runtime/platform is called | 9988, Electron, provider, Safari/WebKit, simulator |

`simulated` does not mean a mock of the API surface. It means a real production
consumer is connected to an alternate implementation of an explicit port.
Recorded and live scenarios must identify the provenance and version of their
inputs in the artifact manifest.

## Capability model

Scenarios depend on capabilities rather than runner names. The initial
vocabulary is:

```ts
export type HarnessCapability =
  | "clock.fake"
  | "clock.real"
  | "transport.memory"
  | "transport.replay"
  | "transport.websocket"
  | "appserver.live"
  | "replica.inspect"
  | "browser.dom"
  | "browser.chromium"
  | "browser.webkit"
  | "browser.resize-observer"
  | "browser.intersection-observer"
  | "browser.visual-viewport"
  | "browser.native-scrollbar"
  | "react.profiler"
  | "tanstack-query.inspect"
  | "electron.main"
  | "electron.webcontents"
  | "electron.preload"
  | "native.ios"
  | "native.android"
  | "native.gesture"
  | "native.keyboard";
```

Capabilities may be extended, but must describe an observable execution
ability rather than a feature name. `timeline` is a domain, not a capability.

Cross-platform scenarios may share actions and invariants while selecting
different probes. Web DOM descendants and native layout handles are allowed to
remain platform-specific. A shared scenario must not pretend those surfaces
are identical.

## Public TypeScript contracts

The first implementation of `@opencraft/harness-core` should expose contracts with
this shape. Exact names may evolve, but the separation of responsibilities is
normative.

```ts
export interface HarnessScenario<TFixture = unknown> {
  readonly id: string;
  readonly owner: string;
  readonly description: string;
  readonly truth: "simulated" | "recorded" | "live";
  readonly requires: readonly HarnessCapability[];
  readonly tags?: readonly string[];
  readonly seed: string;
  readonly timeoutMs?: number;
  arrange(context: HarnessContext): Promise<TFixture>;
  act(context: HarnessContext, fixture: TFixture): Promise<void>;
  invariants(
    context: HarnessContext,
    fixture: TFixture,
  ): readonly HarnessInvariant[];
}

export interface HarnessContext {
  readonly run: HarnessRunIdentity;
  readonly clock: HarnessClock;
  readonly trace: HarnessTraceRecorder;
  readonly artifacts: HarnessArtifactWriter;
  readonly faults: HarnessFaultController;
  readonly capabilities: ReadonlySet<HarnessCapability>;
  readonly services: HarnessServiceResolver;
}

export interface HarnessInvariant {
  readonly id: string;
  readonly description: string;
  check(context: HarnessInvariantContext): Promise<HarnessInvariantResult>;
}

export interface HarnessInvariantResult {
  readonly status: "pass" | "fail" | "not-applicable";
  readonly message: string;
  readonly evidence?: readonly HarnessEvidenceReference[];
  readonly measurements?: Readonly<Record<string, number | string | boolean>>;
}
```

`not-applicable` is valid only when the invariant itself declares a conditional
domain case. A runner capability mismatch is resolved before execution and is
reported as `unsupported`, not as a passing or skipped invariant.

## Cordis boundary

Cordis owns scenario-scoped capability composition and cleanup:

- each run receives an isolated `Context` and set of `Fiber`s;
- Clock, Transport, Storage, AppServer client, Replica, Session, renderer
  registries, Trace, Fault, and lifecycle audit services may be injected;
- plugins register extensions through production registries;
- disposal occurs in reverse dependency order;
- disposal failures are aggregated and fail the run;
- remaining fibers, listeners, timers, sockets, object URLs, and owned records
  are reported as leaks.

Cordis must not own Playwright locators, screenshots, assertions, or platform
gesture syntax. Platform runners expose those through typed drivers. Product
packages must remain usable without the Harness packages.

The existing Chat Render and AppServer Cordis runtimes are the model: Harness
services compose around their public APIs rather than reaching into private
maps or component state.

## Scenario ownership and repository layout

Shared infrastructure belongs in dedicated packages:

```text
packages/
  harness-core/          scenario, capabilities, trace, invariant, artifact
  harness-runtime/       Cordis services, lifecycle and resource audit
  harness-appserver/     transport matrix, recording, WS fault gate, probes
  harness-web/           Playwright, DOM, geometry, scroll, React, Query probes
  harness-electron/      real Electron driver and compositor probes
  harness-native/        simulator/device driver and native probes

apps/
  appserver-lab/         headless AppServer runner
  harness-lab/           interactive scenario and trace workbench

harness/
  catalog.generated.ts   explicit build-safe scenario imports
  playwright.config.ts
  artifacts/
```

Domain scenarios are colocated with their owner and import only its public
surface plus Harness contracts:

```text
packages/timeline-virtualizer/harness/
packages/appserver-session/harness/
packages/chat-document/harness/
packages/chat-render-web/harness/
packages/composer-editor/harness/
apps/workbench-web/harness/
apps/workbench-expo/harness/
```

Scenario files use `*.scenario.ts` or `*.scenario.tsx`. Platform-only scenarios
may add `.web`, `.electron`, `.ios`, or `.android` before the suffix.

Scenarios must not be exported from a package's production root entry. Packages
may expose an explicit `./harness` development export. The repository generates
an explicit `harness/catalog.generated.ts`; shared Expo code must not depend on
filesystem glob imports or Node discovery at runtime.

## Real browser component Harness

Browser component scenarios mount a deliberately small production subtree in a
real Chromium or WebKit page. They are not JSDOM component tests.

For example, the Timeline surface mounts:

```text
production TimelineHostWeb
production VirtualizedTurnList
production Composer
isolated production QueryClientProvider
Memory, Replay, or WebSocket AppServer driver
controllable Clock and WebSocket fault gate
real ResizeObserver, IntersectionObserver, selection, focus and layout
```

Data and external services may be deterministic. DOM layout, scroll physics,
focus, selection, observer delivery, and animation frames must remain native to
the browser engine. Safari-sensitive behavior is approved by WebKit or Safari,
never by Chromium emulation alone.

The local Harness page must use production styles and component entrypoints. It
may add controls outside the measured surface, but it must not add sentinel
elements inside the measured geometry when doing so changes the behavior under
test.

## TanStack Query boundary

Every UI scenario receives a scenario-owned `QueryClient`. It uses production
query keys, query functions, mutation functions, and providers. The Harness may
control the clock, network port, retry policy, and persistence adapter through
explicit configuration; it must not replace product hooks.

The Query probe records:

- query and mutation keys;
- lifecycle transitions;
- retry and cancellation attempts;
- cache writes and removals;
- observer counts;
- hydration and persistence boundaries.

Cleanup fails when observers, mutations, or scenario-owned cache entries remain
after disposal unless the scenario explicitly owns a persistence artifact.

## Trace model

Trace is append-only NDJSON with one common envelope:

```ts
export interface HarnessTraceEvent<T = unknown> {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly sequence: number;
  readonly monotonicTimeMs: number;
  readonly wallTime?: string;
  readonly domain: string;
  readonly type: string;
  readonly correlationId?: string;
  readonly payload: T;
}
```

Initial event families are:

```text
scenario.phase
fault.injected
protocol.frame
transport.status
replica.apply
replica.checkpoint
session.resume
runtime.snapshot
query.cache
ui.layout
ui.scroll
ui.focus
ui.selection
ui.observer
react.commit
resource.acquire
resource.release
artifact.written
invariant.result
```

Sequence is assigned by the recorder and must be monotonic within one run. A
fake clock controls product time but must not be confused with trace sequence.
Binary or large payloads are stored as referenced artifacts with hash and media
type rather than embedded into NDJSON.

Sensitive values are redacted at the source probe. Redaction is part of the
schema contract and must be tested. A sanitized recording includes the source
version, protocol version, SHA-256, redaction version, and capture conditions.

## Artifact contract

Each run writes an isolated directory:

```text
harness/artifacts/<run-id>/
  manifest.json
  trace.ndjson
  invariant-results.json
  runtime-snapshots.json
  protocol-frames.ndjson
  replica-report.json
  query-report.json
  dom-geometry.json
  react-profile.json
  screenshot.png
  video.webm
  playwright-trace.zip
  process-logs/
```

Only applicable files are required, but `manifest.json`, `trace.ndjson`, and
`invariant-results.json` are mandatory for every completed run. The manifest
contains:

- scenario ID, owner, truth level, tags, and seed;
- repository revision when available;
- runner, platform, browser/runtime and protocol versions;
- declared and resolved capabilities;
- fixture and recording provenance hashes;
- start/end time and result;
- artifact paths and SHA-256 values;
- redaction version;
- cleanup and leak-audit result.

The default policy retains all failure artifacts. CI may retain only manifests
and performance reports for passing ordinary scenarios. Differential,
compatibility, and soak reports are retained even on success.

## Fault model

Faults are typed, named, traceable, and reproducible. Initial faults include:

```text
transport.disconnect
transport.latency
transport.drop-frame
transport.duplicate-frame
transport.reorder-window
transport.hold-response
transport.fail-request
protocol.remove-capability
protocol.rewrite-field
replica.epoch-reset
storage.write-failure
storage.corrupt-record
clock.advance
clock.freeze
browser.resize
browser.visibility
browser.delayed-observer
```

Each injected fault writes `fault.injected` before it takes effect. Random fault
selection is permitted only through the scenario seed, and the resolved fault
schedule is written to the manifest. Production code must see the fault through
the real boundary it uses; scenarios must not mutate private runtime state to
simulate external failure.

## Stable identity and geometry

The Web probe assigns observation handles without changing layout. It records
the original node, connectivity, replacement, bounding rect, scroll metrics,
computed overflow, focus, and selection when applicable.

Important reusable invariants include:

- `dom.same-node`: an existing surface was not remounted;
- `dom.connected`: an owned surface stayed attached;
- `geometry.anchor-preserved`: the selected physical anchor remained within
  tolerance;
- `geometry.no-intersection`: two paint/chrome planes never overlap;
- `scroll.root-locked`: the document root did not become the App scroll owner;
- `scroll.composer-stationary`: Timeline elastic motion did not move Composer;
- `scroll.follow-intent-preserved`: system reflow did not become user intent;
- `virtualizer.no-blank-window`: the visible viewport always intersected a
  rendered window or an intentional loading surface;
- `react.no-remount`: the selected Profiler subtree produced no mount commit;
- `resource.no-leaks`: scenario-owned resources returned to baseline.

Pixel tolerances must state whether they are CSS or device pixels. A scenario
must not silently increase tolerance to pass a platform.

## Performance measurements

Performance scenarios measure the path the user sees. Initial metrics include:

- action-to-visible-result latency;
- React commit count and duration P50/P95/max;
- DOM mutation and node replacement counts;
- streaming characters painted per frame and coefficient of variation;
- streaming update-gap P50/P95/max;
- virtualizer mounted Turn count and blank-window frames;
- scroll anchor drift;
- heap after an explicit supported GC boundary;
- pending request, timer, listener, socket, and query observer counts.

Budgets should detect regressions without pinning shared CI hardware to
unrealistic absolute numbers. A metric that can be optimized by doing no work
must be paired with a progress metric; for example smoothness is paired with
characters painted and update-gap limits.

## Platform execution matrix

| Surface | Fast contract | Real behavior gate | Primary concerns |
| --- | --- | --- | --- |
| Protocol/client | Node + Memory/Replay | live `ws://127.0.0.1:9988` | correlation, timeout, abort, reconnect |
| Replica/session | Node deterministic clock | live AppServer recording | convergence, epoch, cursor, authority |
| Chat document | Node | real browser while streaming | stable AST identity, partial syntax |
| Chat render Web | Node compiler tests | Chromium + WebKit | code/math/Mermaid/tool lifecycle |
| Composer DOM | controller tests | Chromium + WebKit | IME, selection, paste/drop, shortcuts |
| Timeline Web | virtualizer tests | Chromium + WebKit | measurement, anchor, elastic scroll |
| Workbench shell | view-model tests | Chromium + WebKit | fixed planes, sidebar, drag/magnet |
| Electron | bridge contract | real Electron | window chrome, focus, IPC, compositor |
| Expo | shared model tests | iOS/Android runner | gesture, keyboard, safe area, lifecycle |

Expo Web is useful as an additional renderer gate but does not approve native
behavior. Vite Web is the authoritative precision desktop browser surface.

## AppServer Lab integration

`apps/appserver-lab` remains the first headless Harness runner. Its existing
scenario names and NDJSON interface remain stable while their implementation is
adapted to the shared catalog and trace contract.

The Lab must be able to select at least:

- MemoryTransport for deterministic development;
- ReplayTransport for sanitized recordings;
- WebSocketTransport for the live 9988 AppServer;
- RecordingTransport around any of the above where meaningful.

Its canonical persistent Thread ID policy remains unchanged. A Harness refactor
must not hide missing, corrupt, archived, or unresumable identity by creating a
replacement Thread.

The Lab's CLI output stays machine-first NDJSON. The interactive Harness Lab may
consume that output, but the CLI must not depend on the browser UI.

## Differential oracles

A behavior-differential program may act as an optional Oracle adapter outside
production packages. Such an adapter must pin every comparison input by SHA-256
before execution.

An Oracle can approve deterministic functions and state-machine transitions. It
cannot approve browser physics, rendering, focus, or compositor behavior unless
the original and OpenCraft are both exercised in the relevant real runtime with the
same observable contract.

Oracle differences are written as structured invariant results with the input,
normalized original output, normalized OpenCraft output, and provenance hashes.

## Lifecycle and isolation

Every run owns all resources it creates. Ownership is explicit; it is never
inferred from `cwd`, a global active host, or the latest Thread.

Runner isolation requirements:

- dynamic ports with protected production/default ports;
- one data/home directory per worker;
- one Cordis context per run or explicitly documented worker fixture;
- one QueryClient per UI scenario;
- temporary repositories and assets with registered cleanup;
- no access to developer hosts, sessions, projects, or credentials unless the
  scenario is explicitly `live` and configured for that target;
- process-tree termination on teardown;
- baseline and final resource snapshots;
- leak cleanup followed by a failed result, never silent cleanup alone.

A server is ready only when its semantic readiness endpoint or handshake
succeeds. A listening TCP port is not sufficient. Browser bundles should be
warmed before scenario timeouts begin so cold compilation is not mistaken for
product latency.

## Test IDs and interaction vocabulary

Stable semantic IDs are part of the cross-platform test contract. Web uses
`data-testid`; React Native uses `testID`/`nativeID`. IDs describe roles and
stable identities, not current English copy or CSS structure.

Reusable actions should form a typed vocabulary such as:

```text
host.connect
thread.open
thread.load-older
composer.focus
composer.submit
composer.stop
timeline.scroll-to-turn
timeline.scroll-away-from-bottom
sidebar.open
sidebar.resize
sidebar.drag
workspace.switch
interaction.approve
interaction.answer
```

Shared actions express intent. Platform drivers implement physical interaction.
A mobile edge swipe and a Web pointer drag may implement the same intent without
sharing coordinates or event syntax.

Assertions prefer semantic identity and visible outcome. Text matching is
appropriate when copy is itself the contract; it is not the default selector.

## CI gates

Harness execution is tiered:

### Tier 0: every pull request

- boundary check and typecheck;
- deterministic unit/contract scenarios;
- generated catalog validity;
- fixture schema and redaction tests;
- Web and Expo build gates.

### Tier 1: affected pull requests

- selected Chromium Harness scenarios;
- Memory and Replay AppServer matrices;
- layout, identity, cleanup, and ordinary performance invariants;
- failure artifact upload.

### Tier 2: main and nightly

- WebKit browser scenarios;
- long-history and streaming stress;
- live 9988 compatibility and recording validation;
- reconnect, reorder, duplicated frame, epoch reset, and storage fault matrices;
- repeated-run leak and soak checks.

### Tier 3: platform runners

- real Electron renderer/main/preload and packaged smoke;
- macOS window and compositor cases;
- iOS Simulator and Android emulator/device gesture suites;
- platform-specific keyboard, safe-area, and lifecycle cases.

CI routing follows the behavior owned by a scenario, not merely the directory
containing the changed file. Cross-package static compatibility remains a type
and boundary concern; expensive full matrices run on main/nightly unless an
affected contract requires them on the pull request.

Flaky scenarios are bugs. They are not weakened, conditionally asserted, or
deleted. Their source of variance must be isolated and represented by a clock,
seed, capability, fixture, or explicit environmental prerequisite.

## Initial implementation order

### Phase 1: foundation and current pain

1. Add `harness-core`, `harness-runtime`, and `harness-web`.
2. Add the explicit scenario catalog and NDJSON/artifact schemas.
3. Adapt `apps/appserver-lab` to the shared run/trace contract without changing
   its existing command semantics.
4. Add Chromium and WebKit Playwright runners using the Vite product subtree.
5. Implement lifecycle, DOM identity, geometry, scroll, React Profiler, and
   Query probes.

The first required scenarios are:

- `timeline/streaming-prepend-keeps-anchor`;
- `timeline/elastic-edge-keeps-composer-fixed`;
- `timeline/hidden-return-preserves-intent`;
- `timeline/no-blank-window-under-long-history`;
- `session/resume-overflow-converges`;
- `shell/sidebar-drag-cancel-spring`;
- `renderer/streaming-rich-content-stable-identity`.

### Phase 2: transport and recovery matrix

- run Session and Replica scenarios against Memory, Replay, and live 9988;
- add the typed WebSocket gate and complete fault schedule;
- record sanitized compatibility fixtures;
- verify cache paint, authority promotion, epoch reset, stale generation, cursor
  exhaustion, and reconnect subscription ownership.

### Phase 3: desktop and native

- build real Electron driver and packaged smoke without product-only branches;
- add Electron compositor, focus, preload, SSH/process lifecycle scenarios;
- add iOS/Android runners for gestures, keyboard, safe areas, native input, and
  foreground/background restoration;
- reuse domain actions and invariants where semantics match; retain
  platform-specific geometry and gesture probes.

### Phase 4: scale and governance

- dependency-aware CI scenario routing;
- performance baselines and trend reports;
- soak, randomized seeded fault schedules, and automatic minimization;
- interactive trace comparison and original-reference Oracle views;
- schema-version migration and artifact retention policy.

## Acceptance criteria for the foundation

The Harness foundation is complete only when all of the following are true:

1. A scenario is authored beside its domain package and discovered through the
   generated explicit catalog.
2. The same AppServer scenario runs through Memory, Replay, and live WebSocket
   drivers without changing product code.
3. A browser scenario runs in Chromium and WebKit against a real DOM.
4. Every run produces the mandatory manifest, trace, and invariant results.
5. A deliberate timer, listener, project, Query observer, socket, or Cordis
   fiber leak causes a failed run with evidence.
6. A deliberate anchor drift, DOM remount, root-page scroll, or Composer
   displacement is caught by a reusable invariant.
7. Existing `npm run gate` remains green and gains targeted Harness gates rather
   than being replaced by one unbounded full-suite command.
8. Production Web and Expo bundles contain no Harness runner, fixture catalog,
   live credentials, or recording payloads.

## Rule for future features

New behavior is implemented and proved in this order:

1. public protocol/domain contract;
2. renderer-neutral production state machine and typed ports;
3. deterministic scenario and invariant;
4. platform adapter and real-runtime scenario where the platform matters;
5. failure artifacts and cleanup audit;
6. CI routing.

If a behavior cannot be exercised without private-state mutation, global
monkey-patching, or a test-only product branch, the production boundary is not
yet deep enough. Refactor the boundary before adding the scenario.

The governing principle is:

> Control inputs, execute production behavior, observe real boundaries, judge
> named invariants, and retain reproducible evidence.
