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

## 2026-11-11 live recheck

**未验**。同模型旧 Codex 路径也在工具前先 401 后 429；Core 账号凭据已过期，
账号池记录 `authorization-rejected`，后续代理返回 `No eligible Codex account`。
按修不了即停的边界，本轮未继续真实任务。证据、范围限制与自行决定见
[本机复查](VALIDATION-LIVE-RECHECK.md)及其脱敏录制。原有 fixture 与真实验收结论分别保留。

## 2026-11-11 resumed after owner re-login

**未验**：Host 执行 CLI 发行成功，但首轮配置的 thread/resume 返回
`no rollout found`，未发送模型任务，未跑完整通信链。
用户重新登录后旧路径同模型回答 OK，原 429 已解除。
[续验范围、脱敏证据与自行决定](VALIDATION-LIVE-RESUME.md)。
