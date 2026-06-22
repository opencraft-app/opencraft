# CloudAgent ACP Runtime And Fault Contract SPEC

Status: draft for human review

Owner: CloudAgent Gateway / Runtime

Scope: ACP protocol surface, CloudAgent ACP extensions, runtime/workspace lifecycle, failure and recovery semantics, and P0 e2e acceptance contracts.

## 1. Purpose

This document is the single reviewable contract for CloudAgent's ACP-facing behavior.

It answers four questions:

1. Which behaviors are standard ACP projection and must remain compatible with generic ACP clients?
2. Which behaviors are CloudAgent-specific extensions and must stay under `_cloudagent.*` or `_meta.cloudagent`?
3. What does the system guarantee for close, resume, restore, restart, and sandbox failure?
4. Which P0 e2e tests lock these guarantees?

This document is not an implementation guide for every function. It is the behavioral contract humans should review before changing gateway, sidecar, runtime host, MyChat, or live e2e tests.

## 2. Architecture Boundary

CloudAgent has four layers:

```text
ACP client / MyChat
  -> Gateway ACP adapter, auth, scope, files, subscriptions
  -> outer runtime host, currently Wisp on AGS
  -> CloudAgent sidecar daemon and AgentRuntime
  -> inner workspace runtime, currently Wisp on a separate AGS instance, created on demand for tools
```

Responsibilities:

- ACP client only speaks ACP plus explicit CloudAgent extensions.
- Gateway owns auth, scope, session lookup, runtime ownership, subscriptions, replay projection, file proxy, and runtime-host control plane.
- Sidecar owns AgentRuntime, transcript/run ledger, prompt execution, tool delegation, and inner runtime binding.
- Outer runtime host owns the long-lived sidecar process boundary.
- Inner workspace runtime owns file/shell/job/artifact capability execution.

Hard boundary:

- ACP/OpenAI/MyChat are projection layers. They must not grow agent decision semantics.
- Gateway history/events are UI projection. Model context must come from sidecar/runtime transcript, not reconstructed gateway UI history.
- Sandbox/template IDs are internal resolved runtime details. Protocol-level user input should use `agent_version` / `workspace_version`, or signed artifact controls explicitly defined by the gateway.

## 3. ACP Standard Surface

CloudAgent keeps standard ACP behavior on the standard methods and notification shape.

Standard methods include:

- `initialize`
- `session/new`
- `session/load`
- `session/prompt`
- `session/cancel`
- `session/close`
- `session/delete`
- `session/resume`
- `session/set_config_option`

Standard notification:

- `session/update`

Rules:

- Standard ACP clients should be able to ignore all `_cloudagent.*` methods and all `_meta.cloudagent` fields.
- Standard `session/update` remains a protocol update stream. Do not invent non-standard `sessionUpdate` enum values for CloudAgent lifecycle.
- CloudAgent private data may be attached under `_meta.cloudagent` on otherwise standard objects.
- CloudAgent private lifecycle events must use `_cloudagent.*` notifications, not fake standard `session/update` variants.

## 4. CloudAgent Extension Surface

All CloudAgent extension method names are prefixed with `_cloudagent.`.

All CloudAgent extension request and response fields use `snake_case`. CamelCase input is not part of the contract.

### 4.1 Methods

| Method | Purpose | Standard client visibility |
| --- | --- | --- |
| `_cloudagent.session.status` | Idempotent session/runtime/workspace status projection | Private extension |
| `_cloudagent.runtime.ensure_ready` | Explicitly restore or verify runtime/workspace readiness | Private extension |
| `_cloudagent.runtime.kill_daemon` | Test-only fault injection: kill sidecar daemon | Private extension, only advertised when fault injection is enabled |
| `_cloudagent.runtime.kill_outer` | Test-only fault injection: delete outer runtime sandbox | Private extension, only advertised when fault injection is enabled |
| `_cloudagent.runtime.kill_inner` | Test-only fault injection: shut down inner workspace runtime | Private extension, only advertised when fault injection is enabled |

Fault-injection methods must not be advertised or accepted in normal production mode.

### 4.2 Notifications

| Notification | Purpose |
| --- | --- |
| `_cloudagent.session.replay_done` | Historical replay is complete for `session/load` |
| `_cloudagent.session.replay_gap` | Replay missed updates; client should resync or warn |
| `_cloudagent.turn.status` | Turn terminal state: completed, failed, cancelled, interrupted, ownership_lost |
| `_cloudagent.workspace.lifecycle` | Workspace/runtime lifecycle phase transition, such as restore/storing progress |

`_cloudagent.workspace.lifecycle` is the protocol-level place for human-visible restore/storing indicators. MyChat should render this as real enter/exit state, not a fixed timer.

## 5. Well-Done Contract

Clients must not infer completion only from WebSocket close, RPC response timing, or UI timeout.

| Flow | Well-done signal | Client behavior |
| --- | --- | --- |
| Transcript replay | `_cloudagent.session.replay_done` followed by the matching `session/load` response | Historical messages are complete. Do not replay historical failures as fresh standard messages. |
| Runtime/workspace restore | `_cloudagent.runtime.ensure_ready` response with `ok=true`, `state="ready"`, `read_only=false`; or `_cloudagent.session.status` with equivalent ready state | Clear "restoring workspace" UI and allow prompt entry. |
| Prompt turn | `_cloudagent.turn.status` terminal notification plus the matching `session/prompt` response | End current turn UI. For failed turns, show the extension error state. |
| Close/delete | `session/close` or `session/delete` response plus optional `_cloudagent.workspace.lifecycle` storing/cleanup updates | Close UI state or remove session according to method semantics. |

Prompt failures:

- Runtime/provider/infra failures return a JSON-RPC error for `session/prompt`.
- Gateway should also emit `_cloudagent.turn.status` with `status="failed"` and structured error details.
- Normal model termination, user cancel, and max-turn style stops return a standard result with `stopReason`.

## 6. Session Lifecycle Contract

The authoritative status fields for UI and client behavior are:

- `lifecycle_state`
- `recoverability`
- `recoverability_note`
- `read_only`
- `runtime_status`
- `runtime_status_source`
- `runtime_status_error`

Compatibility/debug fields such as `state`, `closed`, `runtime_restorable`, and `last_runtime_error` may remain present, but clients should not build primary lifecycle logic from those alone.

### 6.1 Lifecycle States

| `lifecycle_state` | Meaning |
| --- | --- |
| `starting` | Runtime is being created for the first time. |
| `restoring` | Runtime/workspace restore is in progress. |
| `storing` | Close/delete cleanup or workspace storing is in progress. |
| `prompting` | Runtime is live and a prompt is active. |
| `live` | Runtime is attached, writable, and currently idle. |
| `detached` | Gateway has persisted runtime identity but has not verified current process/runtime liveness. Client should call `_cloudagent.runtime.ensure_ready`. |
| `stored_restorable` | Runtime sandboxes are released, but Wisp workspace anchor is restorable. |
| `restore_failed_retryable` | Last restore failed, but a restorable workspace anchor remains. |
| `blocked_terminal` | No valid recovery path exists. Automatic restore should stop. |
| `failed` | Runtime failed; inspect `recoverability`. |
| `closed` | Legacy/terminal closed state when no restorable workspace contract is available. |

### 6.2 Recoverability

| `recoverability` | Meaning |
| --- | --- |
| `live` | Runtime can accept work now. |
| `restorable` | Runtime is not live, but workspace/runtime metadata is enough to recreate it. |
| `retryable` | Last restore failed, but retry may succeed. |
| `terminal` | No automatic recovery path. |
| `unknown` | Runtime identity exists but needs verification. |

Rules:

- Only `live` and `prompting` are writable states.
- `detached` is not an error; it means verify/restore before writing.
- `stored_restorable` is not an error; `session/resume` and `_cloudagent.runtime.ensure_ready` must be allowed.
- `restore_failed_retryable` is not terminal; UI may show retry.
- `blocked_terminal` is terminal; clients should not spin forever.
- `runtime_not_recovered` may appear as a compatibility reason or `recoverability_note`, but it must not be treated as the whole state machine.

## 7. Runtime Ownership Contract

Runtime restore/prompt/cleanup for a session is protected by a session ownership lease.

Minimum conceptual fields:

```text
session_id
generation
run_id
owner_id
operation
fence
ttl / expires_at
```

Rules:

- Prompt, restore, and cleanup must acquire ownership before mutating runtime state.
- Concurrent restore attempts must converge to one runtime owner.
- If ownership is already held, gateway returns a retryable JSON-RPC error with:
  - error code: `runtime_ownership_held`
  - JSON-RPC code: `-32009`
  - `retryable=true`
  - owner/run/session/generation metadata when available
- Ownership contention is not a fatal session failure.
- Multi-process deployments need a distributed implementation of the same lease abstraction. SQLite is acceptable for local/single-node tests; Redis or another distributed lock can replace it later without changing ACP behavior.

## 8. Workspace And Runtime Host Contract

CloudAgent uses two runtime-host layers:

1. Outer runtime host: Wisp running on AGS, hosting the CloudAgent sidecar daemon.
2. Inner workspace runtime: Wisp running on a separate AGS instance, hosting actual file/shell/job/artifact execution.

Rules:

- Tool file and shell operations must execute in the inner workspace runtime, not the outer runtime host.
- The inner runtime is created on demand when a tool requires workspace capability.
- Pure chat should not create the inner runtime.
- `file_list`, `file_read`, `file_write`, `file_search`, `terminal`, and process-like tools require inner workspace context.
- Gateway file transfer endpoints for `/v1/acp/sessions/{session_id}/envd/files` target the workspace abstraction. In Wisp mode, they must go through sidecar/workspace transfer and not bypass into an unrelated outer filesystem.
- Status must not leak inner sandbox ID to normal clients. It may expose `has_inner_envd_target`.

## 9. Close, Resume, Delete Contract

### 9.0 Workspace Pair Identity

In Wisp mode, a CloudAgent workspace is a strong logical pair:

- the outer Wisp runtime that hosts the agent sidecar and runtime store
- the inner Wisp workspace runtime that hosts `/workspace` tools, file transfer, and command execution

The pair has one stable logical workspace identity. Unless the user explicitly calls `/reset` or `session/delete`, the following values must remain bound to the same logical session across `session/close`, `session/load`, `session/resume`, `_cloudagent.runtime.ensure_ready`, gateway restart, sidecar restart, and sandbox recreation:

- `workspace_key`
- `WorkspaceRecord.workspace_id`
- outer Wisp/SMH anchor (`wisp_smh_space_id`)
- inner Wisp name (`workspace_wisp_name`)
- inner workspace runtime id (`workspace_runtime_id`)

The inner workspace id must never be re-derived from the resolved outer SMH space as a fallback. The outer SMH space is an implementation detail of the outer runtime host; using it as the inner workspace identity can make transcript/history recover while `/workspace` points at a different filesystem.

When recovery is driven by `WorkspaceRecord`, Gateway must hydrate both outer and inner pair metadata before starting or binding runtime hosts. A recovery that recreates only the outer runtime but rotates the inner workspace identity is not well-done.

Wisp package artifacts are also part of this lifecycle contract. A package is valid only if mounted or extracted package contents expose executable runtime binaries, including:

- `bin/wisp`
- `bin/wispclient`
- `assets/bin/crun/crun-$GOARCH`
- `assets/bin/tini/tini`

For EROFS packages, runtime hosts must mount with executable semantics. A `noexec` EROFS mount is equivalent to an invalid runtime package because sidecar preparation cannot start Wisp or copy `crun` into the shared runtime tools path.

### 9.1 `session/close`

`session/close` means store/detach, not destroy the logical workspace.

Expected behavior in Wisp mode:

- Stop/release outer runtime host.
- Stop/release inner workspace runtime.
- Clear live runtime targets from session status:
  - `outer_sandbox_id=""`
  - `has_inner_envd_target=false`
- Preserve Wisp/SMH workspace anchor:
  - `wisp_smh_space_id` remains stable
  - workspace record remains restorable
- Session becomes `stored_restorable` when cleanup succeeds and workspace metadata is sufficient.
- Wisp stop/checkpoint is part of cleanup success. If the outer Wisp `stop` path fails its JuiceFS `meta-barrier` / checkpoint cut, close is not well-done and must surface a runtime-host failure instead of silently claiming `stored_restorable`.
- Later `session/resume` or `_cloudagent.runtime.ensure_ready` may create new outer and inner runtime targets.

File persistence guarantee:

- Checkpoint is the durable commit point. A successful Wisp close/checkpoint is the moment CloudAgent may claim workspace writes are durable.
- `active/root-upper.img` is only the mutable working set for the current runtime start. It must not be treated as durable state across close/resume.
- Every `session/resume` / runtime start with an existing checkpoint must rebuild `active/root-upper.img` from the latest committed checkpoint. A stale or corrupt active image must not block recovery when a committed checkpoint exists.
- Files written through workspace tools before graceful `session/close` must be visible after `session/resume`.
- If a file is overwritten, then the next successful `session/close` must checkpoint the overwritten contents. A later restore must read the last confirmed write, not an earlier checkpoint or stale active image.
- This is the primary file persistence contract.

Required close/checkpoint ordering:

1. Stop or quiesce the runtime target that can mutate the active image.
2. Flush the mounted upper filesystem.
3. Flush the loop device.
4. `fsync` the active backing image.
5. Clone/create the checkpoint from the active backing image.
6. Run the file/writeback barrier and metadata barrier.
7. Do not promote the checkpoint back to `active/root-upper.img` during close. The next start/resume owns rebuilding active from the checkpoint.

A close is not well-done if any step that proves the checkpoint durable fails. In that case the session must not be projected as `stored_restorable`.

### 9.2 `session/resume`

`session/resume` means restore a restorable closed session.

Expected behavior:

- Use WorkspaceRecord and runtime metadata to recreate runtime.
- Create a new outer runtime host if previous one was released.
- Recreate inner workspace runtime when workspace tools are needed or when ensure-ready requires it.
- Preserve the same Wisp/SMH workspace anchor.
- Return a loaded session result with lifecycle metadata.

### 9.3 `session/delete`

`session/delete` means logical deletion.

Expected behavior:

- Release live outer and inner runtime targets when possible.
- Mark/delete session record so future status/load/resume fail.
- Do not treat `STOPPED` or already-missing sandbox cleanup as a fatal delete failure.
- A deleted session must not be restorable through `session/resume`.

## 10. Fault Contract

This section defines P0 behavior for real failures. Some failures are injected by test-only `_cloudagent.runtime.kill_*` methods, but the expected recovery path is production behavior.

### 10.1 Sidecar Daemon Kill

Fault:

- The sidecar daemon process inside the outer runtime is killed.

Expected behavior:

- Gateway detects stale/unreachable daemon during next prompt or ensure-ready.
- Gateway restarts/re-attaches daemon inside the same outer runtime when possible.
- Outer sandbox ID should remain the same.
- Runtime transcript/run ledger should still allow the next prompt to recover prior conversation context.

### 10.2 Gateway Process Restart

Fault:

- Gateway process exits and starts again.

Expected behavior:

- `session/load` replays gateway projection for UI.
- `session/load` does not itself start runtime.
- `_cloudagent.runtime.ensure_ready` restores/verifies runtime.
- A closed restorable workspace can be restored after gateway restart.
- The same Wisp/SMH anchor is retained.
- Prompt after restore can read files created before close.

### 10.3 Outer Runtime Sandbox Deleted

Fault:

- The outer AGS sandbox hosting Wisp and sidecar is deleted unexpectedly.

Expected behavior:

- Next prompt/ensure-ready detects stale outer runtime.
- Gateway closes the stale runtime identity and starts a fresh outer Wisp runtime.
- Recovered runtime should use a fresh Wisp runtime name if the previous active image may be damaged.
- Wisp/SMH workspace anchor remains the same.
- After recovery, sidecar daemon starts and prompts can run.
- After recovery, workspace file upload/download and terminal reads work.

Important non-goal:

- Abrupt outer sandbox deletion does not guarantee every dirty write performed immediately before the crash is durable. Durable file persistence is guaranteed by the graceful `session/close -> session/resume` path. Tests for abrupt outer deletion should assert runtime/workspace recovery and post-recovery workspace usability, not assume crash-time dirty data survived.

### 10.4 Inner Workspace Runtime Deleted

Fault:

- The inner workspace runtime is shut down or deleted while the outer sidecar remains alive.

Expected behavior:

- Gateway/sidecar invalidates stale inner target when needed.
- Next workspace tool call creates or binds a new inner runtime.
- Outer runtime remains the same.
- Wisp/SMH workspace anchor remains the same.
- Workspace files that reached the Wisp layer before inner shutdown are readable after recreation.
- No `HTTP 500`, `openresty`, or `sandbox-host ... HTTP transport failed` should be surfaced to the user for the recovered operation.

### 10.5 Active Tool Run Closed

Fault:

- `session/close` is called while a prompt/tool run is active.

Expected behavior:

- Active prompt settles as cancelled/closed/interrupted, not as a hung run.
- Runtime cleanup proceeds.
- Session remains restorable if workspace metadata is sufficient.
- `session/resume` can restore and accept a new prompt.

### 10.6 Concurrent Restore

Fault:

- Two clients call `_cloudagent.runtime.ensure_ready` for the same closed/restorable session concurrently.

Expected behavior:

- At most one owner mutates runtime.
- Other callers either observe the completed runtime or receive retryable `runtime_ownership_held`.
- Final status converges to one live runtime identity.
- Divergent outer runtime IDs for the same generation are a bug.

## 11. Streaming And Replay Contract

Live streaming:

- `session/prompt` sends live `session/update` notifications as deltas arrive.
- MyChat may use `_meta.cloudagent.accumulated_text` as an idempotent accumulated snapshot for rendering.
- Standard ACP clients can append `content.text` deltas in order.
- Transport disconnect must not cancel the running prompt by itself.

Replay:

- `session/load` replays durable UI projection.
- Replay must end with `_cloudagent.session.replay_done`.
- Historical failed turns should not replay as fresh standard error messages.
- If replay misses live updates, send `_cloudagent.session.replay_gap`.

## 12. Error Contract

JSON-RPC errors:

- Infrastructure/provider/runtime failures use JSON-RPC error responses.
- Runtime ownership contention uses JSON-RPC code `-32009`, `error_code="runtime_ownership_held"`, and `retryable=true`.
- Runtime unavailable uses JSON-RPC error with structured `_cloudagent.turn.status failed` when related to a prompt turn.

Stop reasons:

- Normal model completion, user cancel, and expected stop conditions return standard prompt results with `stopReason`.
- Do not encode infrastructure failure as a fake successful `stopReason`.

Status fields:

- `runtime_status_source="runtime"` means the sidecar/runtime answered status.
- `runtime_status_source="gateway_projection"` means gateway projected status because runtime status was unavailable or timed out.
- `runtime_status_error` must carry the reason when runtime status is projected because runtime did not answer.

## 13. Security Contract

Agent binary loading:

- Gateway may resolve an `agent_version` through an allowlist registry.
- Direct sidecar URLs are allowed only through the signed artifact path.
- Sandbox must not execute arbitrary `curl && chmod +x && exec`.
- Agent loader verifies detached `.sig` before `execve`.
- Signature file default may be derived as `${sidecar_url}.sig`.
- `sidecar_sha256` need not be client supplied when detached signature envelope carries SHA-256 and signature verification succeeds.
- Trusted public keys are configured in sandbox/loader config, not downloaded from the artifact URL.

Fault injection:

- `_cloudagent.runtime.kill_*` methods are test-only.
- They must be advertised only when fault injection is explicitly enabled.
- They must not be enabled for normal production traffic.

Secrets:

- Logs and protocol responses must not print API keys, signing private keys, envd tokens, or bearer tokens.
- Status may expose booleans such as `has_inner_envd_target`, not raw inner envd credentials.

## 14. P0 E2E Acceptance Matrix

The P0 live suite runs against real local gateway, real AGS, and real COS.

| Test | Contract locked |
| --- | --- |
| `TestCloudAgentLiveCloseResumePreservesWorkspaceFiles` | Graceful close clears live targets, preserves Wisp/SMH anchor, resume recreates runtime, file persists. |
| `TestCloudAgentLiveGatewayRestartLoadsClosedWorkspaceAndRestores` | Gateway restart does not lose restorable closed workspace; load + ensure-ready + prompt works. |
| `TestCloudAgentLiveCloseAndDeleteHaveDifferentRecoverySemantics` | Close is restorable; delete is terminal and not resumable. |
| `TestCloudAgentLiveConcurrentEnsureReadyConvergesAfterClose` | Concurrent restore converges under runtime ownership lease. |
| `TestCloudAgentLiveCloseDuringActiveToolRunCanResume` | Close during active tool run settles and session can resume. |
| `TestCloudAgentLiveOuterKillRecreatesRuntimeAndPreservesWorkspace` | Abrupt outer deletion recreates runtime, preserves Wisp/SMH anchor, and workspace tools/file transfer work after recovery. |
| `TestCloudAgentLiveInnerKillRecreatesWorkspaceRuntime` | Inner runtime deletion recreates inner workspace runtime without surfacing transport errors. |
| `TestCloudAgentLiveLoadClosedRestorableSessionRecoversOnPrompt` | `session/load` only replays transcript and status; it must not recreate outer/inner runtime targets before the next prompt/ensure-ready. |
| `TestCloudAgentLiveWorkspaceLifecycleNotificationsForCloseAndRestore` | `session/close` and `_cloudagent.runtime.ensure_ready` emit observable `_cloudagent.workspace.lifecycle` storage/restore phases with timing fields. |
| `TestCloudAgentLiveConsecutiveWorkspaceToolPromptsStayWritable` | Two consecutive workspace/`df -h` tool prompts on one live session must keep the session writable and must not surface `runtime_not_recovered` or sandbox-host transport failures. |
| `TestLiveACPWispOuterCloseCheckpoints` | Direct runtime-host e2e: close starts both Wisp layers, shuts down inner workspace runtime, and requires outer Wisp stop/checkpoint to succeed; JuiceFS `checkpoint cut failed` is surfaced as the failure cause. |

Required verification commands:

```bash
cd /Users/skipzhang/code/mono2-clean4/cloudagent/acp-client
CLOUDAGENT_ACP_E2E_URL=ws://127.0.0.1:18094/acp \
CLOUDAGENT_ACP_E2E_TENANT_ID=tenant-live \
CLOUDAGENT_ACP_E2E_PROJECT_ID=project-live \
CLOUDAGENT_ACP_E2E_TIMEOUT=20m \
CLOUDAGENT_ACP_E2E_RESTORE=1 \
CLOUDAGENT_ACP_E2E_FAULT_INJECTION=1 \
CLOUDAGENT_ACP_E2E_GATEWAY_RESTART_COMMAND="$RESTART_CMD" \
GOWORK=off go test ./pkg/acp -run 'TestCloudAgentLive(CloseResumePreservesWorkspaceFiles|CloseAndDeleteHaveDifferentRecoverySemantics|ConcurrentEnsureReadyConvergesAfterClose|CloseDuringActiveToolRunCanResume|GatewayRestartLoadsClosedWorkspaceAndRestores|OuterKillRecreatesRuntimeAndPreservesWorkspace|InnerKillRecreatesWorkspaceRuntime)$' -count=1 -v
```

Regression commands:

```bash
cd /Users/skipzhang/code/mono2-clean4/cloudagent/gateway
GOWORK=off go test ./... -count=1

cd /Users/skipzhang/code/mono2-clean4/cloudagent/acp-client
GOWORK=off go test ./pkg/acp -count=1

cd /Users/skipzhang/code/mono2-clean4/cloudagent/research/hermes-rs
cargo test -p hermes-core -p hermes-sidecar
```

## 15. Non-Goals

These are intentionally not guaranteed by this contract:

- Generic ACP clients understanding CloudAgent lifecycle extensions.
- `session/load` starting or restoring runtime.
- Gateway reconstructing model context from UI history.
- Dirty writes surviving abrupt outer sandbox deletion without a graceful store/close barrier.
- Fault-injection methods being available in production.
- Exposing inner sandbox IDs or envd tokens to normal clients.
- Supporting arbitrary unsigned agent binary URLs.

## 16. Review Checklist

Before changing ACP/runtime/fault behavior, reviewers should verify:

- Standard ACP methods remain usable without `_cloudagent.*`.
- All extension input/output fields are `snake_case`.
- Lifecycle changes update `_cloudagent.session.status` and `_cloudagent.workspace.lifecycle`.
- Prompt infra failures produce both JSON-RPC error and `_cloudagent.turn.status failed`.
- Restore paths preserve Wisp/SMH anchor when recoverability is `restorable`.
- Close/delete semantics remain distinct.
- Tool file/shell operations run in inner workspace runtime.
- New failure behavior is locked by a live e2e or a protocol-level unit test.
