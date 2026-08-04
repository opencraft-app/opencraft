# Managed Computer implementation completion audit（冻结证据）

Baseline: Raft Computer 1.0.13, macOS arm64, Go 1.25.1.

This audit translates the original implementation plan into independently
checkable rows. A passing package or inventory count is not accepted as proof
for a broader row unless the named source/test exercises that behavior.

Verdicts:

- `PROVEN`: current source plus executable local or installed-process evidence
  covers the requirement.
- `SOURCE-ONLY`: implementation is present, but the required failure/sequence
  behavior lacks a direct executable proof.
- `GAP`: current evidence contradicts or does not implement the requirement.
- `CLOUD-GATE`: requires explicit real-account/device approval and is not
  inferred from local mocks.
- `EXCLUDED`: deliberately outside the user-confirmed managed Computer scope.

## Scope, build, and process topology

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| S01 | Work in `research/raft-computer-1.0.13/go-client`, macOS arm64, Go 1.25 | PROVEN | Parent `go.mod` declares Go 1.25.1; final `file` output is Mach-O arm64. |
| S02 | Compile-time Runtime catalog | PROVEN | `internal/runtimes/builtins.go` explicitly registers `codex` and `hermes-acp`; unavailable probes are excluded from the immutable startup snapshot. |
| S03 | One executable provides CLI, `__service`, per-server `__run`, and `__agent-cli` | PROVEN | `cmd/raft-computer-go/main.go`; `internal/command/dispatch_test.go`; supervisor/process tests. |
| S04 | Preserve `CLI → service → one runner per attachment → Runtime` | PROVEN | `internal/service/supervisor_test.go`, `internal/service/process_test.go`, `internal/runner/run_test.go`, and Runtime catalog tests. |
| S05 | Default isolated state root; never read/write official `~/.slock` | PROVEN | `internal/state/paths_test.go`, `internal/computer/app_test.go`, clean-room tests, installed harness isolation. |
| S06 | Development artifact remains `raft-computer-go`; compatibility install may create `raft-computer` alias | PROVEN | `scripts/install-compat-alias.sh` is explicit-only, validates its source, is idempotent for its own link, and refuses to overwrite any existing different command. |
| S07 | No local upgrade/channel/rollback; remote upgrade returns compatible unsupported result | PROVEN | CLI inventory excludes local commands; `internal/runner/core.go` emits `computer:upgrade:done` with `ok:false`. |
| S08 | Clean-room source/build boundary, credential scan, and similarity scan | PROVEN | `internal/cleanroom/guard_test.go`; `docs/clean-room.md`. |
| S09 | New Canary only; never take over an existing Computer | CLOUD-GATE | No real-cloud mutation has been performed. |

## State, service, and Computer CLI

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| ST01 | Planned state topology and restricted directories/files | PROVEN | `internal/state`, `internal/launchenv`, migration and diagnostic paths; mode tests. |
| ST02 | Temp-write, file sync, atomic rename, parent sync for state | PROVEN | `internal/state/store.go`; `internal/state/store_test.go`. |
| ST03 | Access/refresh/Computer/launch credentials stay in `0600` files and out of logs | PROVEN | state/token writers, `computer.RedactedError`, mode and redaction tests, clean-room credential scan. |
| ST04 | File lock and PID attestation | PROVEN | File locking plus 32-byte random service-instance/PID/start-time attestation are enforced by Computer control paths and tested against a mismatched socket. |
| ST05 | `login/logout/attach/setup/start/stop/restart/status/doctor/logs/runners` | PROVEN | `internal/cli/app_test.go` pins command dispatch; workflow/cloud/service tests prove the component behavior. |
| ST06 | Real entrypoint CLI-to-service lifecycle | PROVEN | `TestComputerEntrypointAttestsStatusAndStopsService` drives `__service`, status, already-running start, stop, and cleanup through the actual entrypoint functions. |
| ST07 | Device-code states and refresh-token rotation | PROVEN | `internal/cloud/auth_test.go`, `internal/workflow/login_test.go`, `internal/workflow/attach_test.go`. |
| ST08 | Service crash relaunch and attachment removal | PROVEN | `internal/service/supervisor_test.go`. |

## Control protocol and lifecycle

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| C01 | Bearer WebSocket at `/daemon/connect` | PROVEN | `internal/control/transport.go`; transport and runner handshake tests. |
| C02 | Type-first strong decoding, unknown-field preservation, unknown-event tolerance | PROVEN | protocol codec/frame tests and `TestCoreReportsUnknownFrameWithoutDisconnecting`. |
| C03 | 1s exponential reconnect capped at 30s | PROVEN | Backoff unit tests prove the default sequence; real WebSocket watchdog test proves transport reconnect through that backoff boundary. |
| C04 | 70s silence → ping → second silence reconnect | PROVEN | `TestTransportWatchdogPingsThenReconnectsAfterSecondSilentInterval` uses a shortened injected interval and real sockets. |
| C05 | Terminal `legacy_machine_key_migrated` rejection stops reconnect | PROVEN | `TestTransportStopsAfterTerminalLegacyMigrationRejection` proves one handshake attempt and typed terminal exit. |
| C06 | Honest ready: capabilities, Codex Runtime, running Agents, system/version, migration, lifecycle acks | PROVEN | `internal/runner/core.go`; ready/reconnect tests; installed differentials. |
| C07 | Durable delivery before `agent:deliver:ack`; transient ack only after lifecycle acceptance and without durable commit; ack is not completion | PROVEN | Core receipt tests, the frozen delivery-state table in `control-protocol.md`, direct Manager/Controller state tests, and installed busy/live-idle/idle-snapshot/credential-cooldown differentials. The installed cooldown proof shows no ack when credential restart fails and an ack for the next message accepted into cooldown; injected-clock tests prove raw-message carryover, failed-resume retention, post-expiry automatic-restart transfer, mixed durable/transient wake batching, aggregated turn-boundary delivery, transient completed-session cleanup, one-shot consumption, and launch/failure fencing. Deferred input is accepted before completion/idle publication, with one in-flight retry owner per pending head. |
| C08 | Only replayable activity coalesces across disconnect | PROVEN | Core tests prove latest-only coalescing, first-insertion order, launch-aware invalidation, stale enqueue rejection, and activity-before-ready. The installed official-vs-Go reconnect scenario proves the observable replay/ready partial order. Other results have no outbox path. |
| C09 | Operation/request idempotency and launch fencing | PROVEN | lifecycle store, Controller, Agent Manager, runner lifecycle tests. |
| C10 | Graceful shutdown/restart lifecycle frames | PROVEN | transport shutdown, core shutdown, restart persistence, and installed runner tests. |

## Agent boundary and Codex-facing CLI

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| A01 | At most five concurrent starts, 500ms launch spacing, ordered inbox | PROVEN | Agent Manager defaults/source; concurrency, queue ordering, durable inbox tests. |
| A02 | Launch-scoped loopback gateway and `sap_` + 32 random-byte token | PROVEN | gateway source/tests and launch environment tests. |
| A03 | Expired/missing/invalid token, route/capability fence, identity overwrite, hop-by-hop stripping, redirect refusal | PROVEN | `internal/gateway/gateway_test.go`. |
| A04 | Strongly typed Agent API and minimum observed response validation | PROVEN | `internal/agentapi`; all 70 command-path contract tests. |
| A05 | Complete Codex-facing `raft` CLI families and output/error semantics | PROVEN | compatibility matrix: 60 text + 1 binary remote paths; 54 installed official-vs-Go command differentials. |
| A06 | Generated `raft`/`slock` wrappers, proxy/token/capability identity, loopback `NO_PROXY` | PROVEN | `internal/launchenv/prepare.go` and tests; Controller tests. |
| A07 | Workspace, skills, diagnostics, reminders, machine workspace | PROVEN | workspace/diagnostic/reminder/runner tests and installed reminder differential. |
| A08 | External-Agent login/bridge commands | EXCLUDED | The managed Computer client returns a clear unsupported result; wake-bridge onboarding remains a separate product path. |
| A09 | Legacy local `migrate export/import` | EXCLUDED | Object-store control migration is implemented; local archive commands are explicitly unsupported. |

## Codex Runtime

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| D01 | PATH/macOS-app probe and `app-server --help` | PROVEN | `internal/codex/driver.go`; driver probe/start tests. |
| D02 | Stdio app-server initialize/initialized, thread start/resume, turn start/steer | PROVEN | Driver tests, installed lifecycle differentials, and complete byte-exact cold/transient-wake/durable-wake/rich-inbox/empty-resume input sequences. Durable-wake oracles compare both startup and deferred idle `turn/start` inputs. |
| D03 | Missing-resume cold start with diagnostic recovery context | PROVEN | bounded classifier/unit tests and installed missing-session differential. |
| D04 | Normalize text/reasoning/tool/usage/session/turn/error and suppress secondary/stale output | PROVEN | Codex normalizer tests, trajectory tests, and installed process differentials, including nested-only correlated-response input evidence with root-alias rejection, independent top-level/nested/session notification identity fallback after empty or non-string candidates, ordinary `thread/started` secondary fencing plus empty-string adoption, bounded correlated-startup notification adoption, falsy repeated `turn/started` active-ID preservation with evidence reset, top-level/nullish thread-status precedence, waiting-flag filtering/order/multiplicity, status-local native-reason trimming/bounding, original top-level fallback-reason and generic non-retryable error-message preservation after JavaScript non-empty validation, exact failed/interrupted completed-turn native-message preservation, JavaScript-compatible array-shaped token-usage evidence and rate-limit liveness, array-shaped raw-response progress, JavaScript-compatible diagnostic trimming/bounding, same-ID lifecycle phase replacement/clearing, reader-ordered startup thread adoption, single startup session publication plus turn-end session refresh, initial-prompt thread pinning, independent empty agent-message/reasoning-summary identity suppression, delta/completed-local agent-message phase behavior, inert empty reasoning-text deltas, empty completed-reasoning evidence, inert empty file-change lifecycle frames, unclaimed thread/turn-result adoption, and unclaimed JSON-RPC response-error projection. |
| D05 | Busy steering, launch/session fencing, running/queued rebind, terminal recovery, stalled recovery | PROVEN | Codex, Agent Manager, Controller, Core, and installed process tests, including single-process same/new-launch rebind, queued-wake preservation, Agent-scoped committed input across rebind, transient state gating, and atomic terminal handoff. |
| D06 | Graceful interrupt and deadline-bounded forced kill | PROVEN | `session.Stop` and driver process tests. |
| D07 | Model detection with bounded pagination and metadata | PROVEN | model-list unit tests and installed model differential. |
| D08 | Wrapper/environment injection into each launch | PROVEN | launch environment plus Controller tests. Observed identity surface is Agent/launch/server, not a machine-ID environment variable. |
| D09 | Initialize-result Runtime home, reachable session references, transcript/feedback reuse, and Runtime-aware skills | PROVEN | Driver optional-capability tests, launch-fenced Agent Manager profile tests, shared path-only/native/handoff diagnostic tests, Core transcript/feedback/skills tests, and the installed official-vs-Go Runtime-home session-reference differential. |

## Object-store migration

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| M01 | v2 format/media type and manifest/workspace-only archive | PROVEN | `internal/migration/archive.go` and archive tests. |
| M02 | Reject absolute/traversal/link/duplicate/undeclared/hash-invalid entries | PROVEN | Extraction validation, malicious archive tests, and direct duplicate/hash-shape limit tests. |
| M03 | Exclude regenerable and common credential files | PROVEN | archive filter and secure bundle test. |
| M04 | 250,000 entries, 64MiB manifest, lease `maxBytes` | PROVEN | Direct bounded tests cover over-entry, oversized-header, and content-byte limits without materializing huge payloads. |
| M05 | Target reserve `2 × contentBytes + 512MiB` and atomic adoption | PROVEN | `Adopt` implementation and disk/destination/placement test. |
| M06 | Source spool, PUT, source-ready, manifest SHA-256, cleanup | PROVEN | Coordinator source tests and installed upload differential. |
| M07 | Target retry within lease, staged validation, rebind order, arrived report | PROVEN | Happy path and installed target differential pass; deterministic tests pin retry timing, token reuse, success, cleanup, and exact lease-expiry stop. |
| M08 | Stale `start-transfer` generation refresh/retry | PROVEN | `TestCoordinatorRefreshesStaleStartTransferGenerationOnce` pins the observed 409/code, grant refresh, and exactly one retry. |
| M09 | Failure cleanup, transport-lost, and atomic placement rollback | PROVEN | `transport-lost`, spool/stage cleanup, preflight destination preservation, insufficient-disk refusal, and atomic staged placement are tested. Official 1.0.13 also retains an already placed workspace after a later rebind failure. |
| M10 | Same lease cannot run twice concurrently | PROVEN | `TestCoordinatorRejectsConcurrentSameLease`. |

## Verification and release gates

| ID | Requirement | Verdict | Authoritative evidence / remaining work |
| --- | --- | --- | --- |
| V01 | Sanitized fixtures for every observed control type and optional/unknown/malformed cases | PROVEN | protocol corpus, evidence ledger, codec/parser tests. |
| V02 | Local official-vs-Go protocol differential harness | PROVEN | `internal/differential`; 74 installed Codex scenarios, including malformed typed error envelopes, numeric-equivalent response IDs, initialize result/error precedence, app-server and isolated-cache model discovery, malformed/non-object live stdout tolerance with valid-trajectory continuation, raw-ID app-server server-request rejection, reachable initialize-result Runtime-home session references, root-only correlated-response input-evidence fencing, falsy repeated turn-start steering preservation, empty thread-started adoption, mixed-type secondary-thread identity fencing, array-shaped token-usage turn evidence, exact failed/interrupted completed-turn and generic terminal-error message preservation, waiting-flag multiplicity/order, top-level fallback-reason preservation, astral diagnostic and status-local native-error bounding, top-level/nullish thread-status precedence, array-shaped raw-response progress, same-ID lifecycle phase replacement, startup thread-ready/session ordering, turn-end session repetition, native/reasonless system-error, ordinary interrupted-turn detail, empty terminal-error, unclaimed response errors and thread/turn results, empty agent-message/reasoning-summary identity suppression, inert empty reasoning-text, completed-reasoning, and file-change items, delta/completed-local agent-message phase behavior, ASCII/UTF-16 shell-tool bounds with raw split-surrogate bytes, semantic tool labels, and long MCP display-label branches. |
| V03 | Fake and real Codex smoke behavior | PROVEN locally | Deterministic fake app-server cases plus the installed native Codex lifecycle differential pass. Real cloud delivery remains a cloud gate. |
| V04 | Duplicate/out-of-order/reconnect/stale-output/service/IPC failures | PROVEN | Direct transport watchdog/reconnect/terminal tests and real entrypoint service lifecycle now complement the existing Manager/Core/IPC failure matrix. |
| V05 | Each Agent CLI command: success, authorization, arguments, malformed server shape | PROVEN | 70-path contract suite and output evidence ledger. |
| V06 | Capability gateway security matrix | PROVEN | complete gateway tests. |
| V07 | Migration security/failure matrix | PROVEN | Happy paths, both installed migration roles, retry/expiry, stale generation, limits, unsafe/duplicate/hash-invalid entries, disk/destination preservation, redirects, and transport loss are covered. |
| V08 | Full tests, race, vet, credential/similarity scan | PROVEN | Phase 72 reran the full suite, race detector, vet, formatting/JSON/shell and all three clean-room scans; every Agent CLI differential passed in 74.760s and all 74 Codex differentials passed in 148.312s. |
| V09 | `-trimpath` macOS arm64 artifact with real Go-client version | PROVEN | `bin/raft-computer-go` is a 16,489,922-byte Mach-O arm64 executable built with Go 1.25.1; SHA-256 `aa2fa6d07a027f15f96f5efa540312d1be1507a72e4b3b8ebdc0d0360838cea7`. |
| V10 | Real-cloud Canary: online/start/deliver/CLI/workspace/reminder/reconnect/migration | CLOUD-GATE | Requires explicit device approval and cloud mutation; not yet run. |

## Hermes ACP Runtime

| ID | Requirement | Status | Evidence |
|---|---|---|---|
| H01 | Compile-time `hermes-acp` registration without runner branches | PROVEN | `internal/hermes/registration_test.go`, `internal/runtimes/builtins_test.go`, architecture source scan. |
| H02 | Explicit/sticky/default Profile resolution and isolated Runtime home | PROVEN locally | `internal/hermes/profile_test.go`, `internal/workspace/service_test.go`. |
| H03 | ACP initialize/new/load/prompt/cancel and normalized events | PROVEN locally | Deterministic fake ACP process in `internal/hermes/driver_test.go`. |
| H04 | Busy redirect/queue behavior and non-interactive permissions | PROVEN locally | Fake ACP redirect, cancellation, and permission-response capture. |
| H05 | Resume history does not become a new cloud reply | PROVEN locally | `TestDriverResumeSuppressesHermesHistoryReplay`. |
| H06 | Real installed Hermes and cloud Canary | BLOCKED locally | The installed `~/.local/bin/hermes` points at a virtual-environment Python symlink that is currently missing. No user Hermes state was modified. |

## Current correction queue

Phase 72 completes the malformed typed-envelope slice: error own-field
presence, JavaScript truthiness, independently compatible message/code fields,
method-specific result/error precedence, and numeric-equivalent pending IDs are
now preserved across persistent sessions and model discovery. Truthy
non-string nested `error.message` remains a separately evidence-gated
robustness oracle. Systematic branch-level local auditing remains active;
real-cloud Canary acceptance remains approval-gated.
