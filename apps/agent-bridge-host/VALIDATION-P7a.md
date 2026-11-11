# P7a local validation

Initial base: `114a08539e`; rebased onto `bc296ac855` with `--no-autostash`; branch `feat/agent-bridge-p7a`. No deployment, default
engine switch, Hermes change, push, PR or automation command is included.

## Implementation decisions

- Server admission signs a dedicated execution-CLI audience after domain admission.
  Host verifies that signature and exact Server/Thread pair, and rechecks current
  Server admission before publishing a private execution launcher. The extra
  admission lookup runs in the existing orchestration Worker.
- CLI descriptors point to a Host forwarding endpoint. Only live Host leases
  forward using the Server execution bearer retained only in Host; descriptors contain a distinct opaque Host bearer. Copying them cannot bypass Host revocation by calling Server directly. Terminal callbacks, stop and owner loss
  revoke forwarding. Server retains per-call delegation/resource checks and owns
  the sender identity, write budget and durable operation receipts.
- Codex configuration refresh has one shared owner. The legacy path keeps its
  existing permission capture, runtime retirement and settings restoration order;
  the bridge consumes the same owner for execution environment changes.
- `thread input status` takes an operation ID, keeping lookup restricted to the
  calling delegation and checking target read access before reading delivery.
- `tell --delivery native` maps to the existing native steer path and requires an
  expected Turn. Queue uses the existing durable input path. Interrupt is explicitly
  unsupported by the current Broker authority; it never silently becomes queue.

## Verification

After rebase, the frozen source passed:

- `npm run test:agent-bridge`: 209 passed, one opt-in Core probe skipped.
  The runner removes the inherited invalid `BASH_FUNC_which%%` environment key;
  production sandbox validation remains strict.
- Focused CLI, legacy MCP refresh, session capabilities, IM read tools, legacy
  Codex adapter, Broker and headless entry regression tests: 168 passed.
- Additional Codex gateway and Actor collaboration permission regressions
  (including user approval with CLI enabled): 28 passed.
- Root `npm run typecheck` and `npm run check:boundaries`: passed.
- `npm run build:codex --workspace @opencraft/agent-bridge-host`: passed.

The rebase retained P3c resume checks and typed refusal, P2d dispatch settlement,
abandon and evidence reconciliation, P9 compatibility tests, P3b DSH dialect
and P4 CodeBuddy adapter behavior. No running
service consumes the new local bundle.
Real model acceptance is separate from deterministic native-boundary fixtures.
The recorded local Codex Core native socket was absent during this run. No Core
was started and no other CODEX_HOME writer was opened. A real model
spawn/tell/wait/output chain has therefore not been verified.

## Remaining provider scope

The configured independent Codex Host path consumes the new execution CLI port.
Other providers have no new execution environment adapter in this change and must
not advertise CLI execution merely because they support a shell. A configured
Host skips issuance for undeclared providers and permits their ordinary turns.
A declared CLI provider without valid admission fails closed with `cliUnavailable`.

## Independent review

First review: `thr_ib9yikrd2v`. Three P1 findings were accepted and fixed:
preparation failures no longer mark an unsent native Turn unknown; direct Server
bearer descriptor issuance was removed; and the main CLI fixture now invokes the
actual launcher through Host gateway, Host forwarding, Server authorization and
Broker. It covers spawn/tell/wait/output and gateway restart. The production Turn
binding wait helper and the bridge retirement polling branch have regressions.
The optional existing-Core probe remains opt-in and does not claim a model task.

Second review: `thr_dms6qaas4f`. One P0 and two P1 findings were accepted
and fixed. The signed admission wrapper now surrounds the configured Server-side
Codex ProviderBridge, rather than the legacy adapter. The headless entry accepts
`--codex-agent-bridge-config` beside its existing Core attachment. A daemon relay
alone cannot mint domain authority. Providers without CLI capability keep their
ordinary turn behavior. Bridge preparation has a deadline capped at ten seconds
and half the Host RPC budget. A rejected close preserves the running execution
lease until its terminal event. Known preparation failure rejects before native
start and revokes its lease. Ambiguous native configuration changes fence further
configuration instead of replaying them. Legacy retirement timing stays unchanged.

Regressions exercise the bundled provider through Host and the Server admission
factory, both with and without CLI, and a retirement timeout followed by a new
admission. They check retained read-only/approval settings and the separately
injected platform MCP configuration. The CLI fixture also verifies that IM MCP
remains usable, signatures cannot cross protocol audiences, resource revocation
blocks issuance and existing leases, and changed keys return HTTP 409 after
restart. Both reviews found defects. Their final fixes were checked by the primary
agent with deterministic regressions, without a third independent review.

The focused command was `node --import tsx --test` with these paths:

- `tests/identity/thread-cli.test.ts`
- `tests/identity/thread-orchestration-broker.test.ts`
- `tests/identity/thread-orchestration-ledger.test.ts`
- `tests/execution/session-mcp-refresh.test.ts`
- `tests/execution/codex-engine-adapter.test.ts`
- `tests/execution/session-capabilities.test.ts`
- `tests/extensions/im-read-tools.test.ts`
- `tests/server/headless-server.test.mjs`

The additional permission run used the same runner with
`tests/agent-bridge/codex-gateway.test.ts`,
`tests/identity/actor-collaboration.test.ts`, and
`tests/identity/actor-collaboration-codex.test.ts`.
The Host workspace typecheck also passed after the final lease cleanup fix.

## 2026-11-11 live recheck — historical, before repair

**未验**。同模型旧 Codex 路径也在工具前先 401 后 429；Core 账号凭据已过期，
账号池记录 `authorization-rejected`，后续代理返回 `No eligible Codex account`。
按修不了即停的边界，本轮未继续真实任务。证据、范围限制与自行决定见
[本机复查](VALIDATION-LIVE-RECHECK.md)及其脱敏录制。原有 fixture 与真实验收结论分别保留。

## 2026-11-11 resumed after owner re-login — historical, before repair

**修复前未验**（PR #233）：Host 执行 CLI 发行成功，但首轮配置的 thread/resume 返回
`no rollout found`，未发送模型任务，未跑完整通信链。
用户重新登录后旧路径同模型回答 OK，原 429 已解除。
[续验范围、脱敏证据与自行决定](VALIDATION-LIVE-RESUME.md)。

## First-turn lifecycle repair — 2026-11-11

**Current P7a result: the repaired Codex first-Turn CLI chain passed live acceptance.**
The two preceding failed rechecks remain historical evidence, not the current
status. Other-provider and production-composition gaps remain as recorded.

The deterministic regression reproduces the native boundary: creation succeeds,
but `thread/resume` before the first user Turn returns `-32600 / no rollout
found`, leaving CLI preparation rejected with no model Turn. Local protocol-only
probes confirmed this on the attached Core (`0.162.1`); the installed CLI on PATH
is separately `0.167.0`. Settings updates, history reads and unsubscribe do not
make an empty legacy allocation resumable. Unsubscribe also does not imply runtime
retirement.

The final repair does **not** replace native sessions. Host reserves a private,
one-shot launcher namespace before native creation, with no connection descriptor
or execution authority. Native creation installs that known environment under the
original permission settings. Only after Server admission, signed-source
verification and the existing live admission lookup does Host publish the first
execution's descriptor into that namespace. It binds once; terminal, stop and
owner-loss cleanup revoke it. A definitive rejection before any observed Turn
revokes the old token and descriptor and rearms the same namespace; unknown
outcomes and observed Turns retain custody and never rebind. Later executions get separate namespaces.

The Codex owner captures the installed initial configuration. For a known
unmaterialized first Turn it checks idle status, the native history refusal and
exact environment/MCP equality, then uses those already-installed settings without
resume, settings mutation, unsubscribe, deletion or an identity change. A positive
history read or an observed/attempted Turn defeats the creation evidence. A typed
definitive no-start refusal restores it only when no native Turn was observed. Existing
rollout sessions keep the shared capture/resume/retirement path. Deadline and
configuration mismatch failures perform no native mutation and do not permanently
fence a safe retry. Busy, ambiguous and unrelated history failures fail closed.

Existing platform MCP tools use an unbound first-execution reservation installed
at creation and bound only after domain admission. This new bridge path uses an
explicit memory-only MCP audience: prepare, bind, revoke and rejected old-token
requests never access the SQLite binding owner. Existing persistent legacy MCP
reservations retain their original default and listener-replacement behavior.
Concurrent creation claims share one reservation; rejection of one claim cannot
cancel another pending or installed claim. No orchestration `thread_*` or
`thread_cli` MCP tool is restored.

### Live evidence

[Sanitized recording](../../design/agent-bridge/recordings/p7a-first-turn/codex-cli.json)
contains CLI receipts, public history, reserved/admitted phases, the original
native identities and selected native rollout events/tool outputs. The successful
chain uses `gpt-5.6-luna`, low reasoning, with exactly one parent and one child
model Turn, both completed. The parent runs its execution launcher, spawns one
child, sends native tell with the active expected Turn, waits and reads output.
Both initial and steered user messages occur in the same child Turn, which returns
`P7A_TELL_OK`; the parent returns `P7A_PARENT_OK`. Native IDs are the original
creation IDs throughout. The recording's source fingerprints and bundle SHA-256
identify what was exercised.

The reproducible, explicitly opt-in harness is
`scripts/smoke/execution/smoke-codex-first-turn-cli.ts`; it requires an existing
Core attachment via `OPENCRAFT_CODEX_CORE_CONFIG` and an output file via
`OPENCRAFT_P7A_EVIDENCE`. It never starts another account owner. It creates local
Server/Broker/Host components and temporary create/read/queue/prepare adapters,
uses the real Server admission wrapper and Host forwarding, then closes services
and removes credential files, databases and task directories. The Host transport
uses the existing test process backend; model tools use the existing Core. This
is not production headless composition, production sandbox isolation or client
acceptance.

During investigation, disposable harness attempts exposed private temporary cwd,
unsupported CLI flags, reference/input-ID handling, continuation wiring, snapshot
state and per-input evidence negotiation errors. They were fixed in the harness,
without weakening admission or replaying uncertain input. An earlier queue
follow-up reached issuance but configuration preparation rejected before a second
child Turn; its precise native stage was not captured. Queue follow-up therefore
remains unverified. The successful chain uses the existing native-steer contract.

### Decisions introduced

- Reserve an unprivileged first-execution namespace before native creation and
  bind it once after admission. Retain the native and canonical Thread identities;
  never synthesize a rollout, send a seed model Turn or recreate the session.
- New opt-in Codex bridge creations with a reserved CLI environment default to
  legacy history unless the caller explicitly chooses a history contract. The
  attached minimum native exposes an unambiguous unmaterialized-history refusal
  for that contract. An unsupported explicit contract fails closed; default
  legacy-engine creation and existing Thread history contracts are untouched.
- Keep the new MCP reservation in memory for the Server owner lifetime. It is not
  durable execution authority or a promise of automatic recovery after Server
  owner loss. No new main-thread SQLite path or migration is introduced.
- Use the requested `gpt-5.6-luna`, low reasoning, without claiming a newly checked
  absolute price ranking. The real chain selects its issued launcher through
  `OPENCRAFT_THREAD_CLI` and native tell; queue follow-up stays a stated limit.
- Use an isolated dependency view with workspace packages resolved to this
  checkout. The removed reference worktree's SDK dependency was replaced by a
  temporary install of the lockfile's exact SDK version; temporary transitive
  dependencies are not claimed byte-for-byte identical to the lockfile. No
  package metadata or lockfile changed; temporary dependency files are removed.

### Verification and independent review

Before every test command, `BASH_FUNC_which%%` was removed. Root `npm run
typecheck` and `npm run check:boundaries` passed, as did 137 focused default Codex
adapter, MCP refresh, capability, IM, CLI and headless regressions. Final bridge
verification uses `npm run test:agent-bridge -- --test-concurrency=4`, running all
313 tests (312 passes and the existing opt-in Core probe skipped) per iteration.
All ten consecutive final runs passed with those counts.

The default 32-file parallel runner exposed unrelated Cursor/Claude timing
flakes under shared-host load. Four-file concurrency retains every test and
assertion. Two gateway fixture races were corrected: await actual interaction
cache cleanup, and replace restart sleeps with explicit hold/release plus durable
completion before reattachment. Native PID, single-Turn, single-side-effect and
no-replay assertions remain. Live output checks require completed Turns and an
exact final assistant marker, so user prompt text cannot satisfy acceptance.

First review: `thr_j67tsdet3p`. All six P1 findings were accepted. The reviewed
replacement candidate was removed; its live result is not claimed as evidence
for the final implementation.

| Finding | Final disposition and regression |
| --- | --- |
| Metadata-only read cannot detect history | Full history probe; created-plus-materialized-history test keeps native ID and uses resume |
| Turn observed during async read ignored | Recheck the same initial configuration after reads; mid-read native Turn test |
| Premature permanent replacement fence | No replacement mutation or fence; mismatch/deadline failures followed by successful preparation |
| Unsubscribe treated as runtime retirement | No initial runtime retirement; bundled first-turn test rejects any resume before rollout |
| Crash window before replacement identity persistence | No new identity transition; one native creation and one original identity callback |
| Missing new-branch tests | Added first-turn owner, bundled Host/Server, one-shot CLI publication, revocation and memory-only MCP I/O regressions |

Second review: `thr_tc9b62aqus` (`bb-dispatch --difficulty simple`, DSH /
deepseek-v4.1-flash, max). All six P1 findings were accepted and fixed locally;
no third review round was dispatched.

| Finding | Final disposition and regression |
| --- | --- |
| Host unknown response reclassified at Server | Gateway uses durable receipt state, normalizes unknown errors and drains committed events before replying; bundled Host→Server tests assert one started binding and no reset |
| Terminal-before-error loses observed start | Track the pending start command independently of the live CLI lease; open→close→explicit-error stays unknown and never rearms |
| Pre-dispatch create exceptions leak claims | Settle failed creation claims before rethrow; protect duplicate preparing request IDs and closed owner; 300 real uninitialized-provider failures revoke old tokens (401) and leave new reservations usable |
| Installed but unstarted reservations exhaust pending capacity | Installed memory scopes follow native-session lifetime instead of the 256 pending-preparation quota; admission owner close cancels them, Host session/owner close revokes unbound launchers, native unsubscribe clears creation evidence. Test 300 installed idle scopes, owner close, old-token 401 and unchanged 256 legacy pending limit |
| Mid-read test did not exercise the guard | Inject Turn notification while history still reports unmaterialized; require shared resume refusal and no input. Add busy and unrelated-history-failure checks |
| First-turn preauthorized tool policy missing | Refresh the known scope before reservation and install its per-tool approval table at creation; preserve current declarations at admission, fail closed if they were not installed. Native owner and real memory-MCP tests preserve `approval_mode: approve` |

Additional lifecycle decisions: unsubscribe is a subscriber operation, so it does
not abandon an accepted native allocation or impose an idle expiry on first-Turn
configuration. Real session/owner close releases its resources. Closing the
Server admission owner cancels its in-memory bindings; automatic first-Turn
recovery after that owner loss is not claimed. Unknown submissions retain the
original source for delayed native binding and are never reset or replayed.
Scoped memory bindings do not consume the existing pending-preparation budget;
legacy/persistent pending behavior and its 256-entry limit remain unchanged.
The real harness also checks the installed platform preauthorization table.

Final ten-run verification: **10/10 passed**, each 312 passes, zero failures,
one existing opt-in skip. Root typecheck and boundaries, 137 default/legacy
regressions and 63 review-focused checks passed. The final strengthened token
revocation regression was included in every one of these ten runs. Both review
threads have accepted dispositions recorded and are archived.

A gitleaks scan of the delivered files found no secrets, and those files contain
no machine-specific checkout or home paths. The current Git author/committer
identity is the requested personal identity. The identity audit also reports
pre-existing historical metadata mismatches; historical commits were not rewritten.

The original local delivery had no default-engine or Hermes changes, deployment,
push or PR. Other providers,
queue follow-up, production composition, Web/Electron/Expo and owner-restart
recovery remain outside the claimed real acceptance.

## Rebase onto PR #233 and #234 — 2026-11-11

Rebased onto `origin/main` at `b78b072749`, which includes both upstream PRs.
Documentation conflicts were resolved by retaining PR #233's pre-repair
`no rollout found` failure and P2a/P7b/P4 results, then marking the repaired
P7a native CLI chain as the current result. The original failure recording
remains intact; no older missing-coverage claim was silently replaced.

PR #234's external-file credential ownership is consistent with the bridge.
`CodexOwnerConnection` still obtains only synthetic broker authentication from
the unchanged `CodexCoreControlClient.brokerAuth()` and returns that synthetic
credential to native broker refresh requests. It does not import, copy, read,
refresh or persist the user's external auth file. Real account selection and
external-credential failure/renewal remain in Core and the account-pool owner.
No source conflict or authentication-path edit was required during rebase.

The original live recording identifies its original base and artifact; it was
retained rather than relabeled as a new post-rebase model run. This follow-up
checks the combined source with deterministic bridge and account/Core tests.
No further paid model task was needed for the documentation-only rebase.

Post-rebase verification passed:

- `npm run test:agent-bridge -- --test-concurrency=4`: three consecutive runs,
  each 312 passes, zero failures and one existing opt-in skip.
- Root `npm run typecheck` and `npm run check:boundaries`: passed.
- Account-auth, account-pool and Core regressions: 135 passes, zero failures and
  one existing opt-in skip across 136 tests.
- Documentation links, conflict-marker and whitespace checks: passed. Gitleaks
  found no secrets in the delivery files, which contain no machine paths.

All test commands remove `BASH_FUNC_which%%`.
The follow-up explicitly authorizes pushing the feature branch and opening a
PR against main; it does not authorize merging or deployment.
