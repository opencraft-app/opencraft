# Generic ACP provider bridge (P3)

Opt-in provider bridge for Agent Client Protocol (ACP) agents on the P1a/P1b
agent-bridge foundation. It does not participate in any existing engine's
default route; a Thread is pinned to it only when the gateway registers and
activates this bridge as its generation.

The bridge process speaks the P1a JSONL protocol on stdio toward the Engine
Host and ACP JSON-RPC over stdio toward one installed agent process per Thread.
The Host owns sandbox, command custody and durable outbox; this package owns
native session lifetime, ACP translation, capability probing, permission mode
application and per-input steer evidence.

## Launch configuration

The package is a pinned bridge artifact. The generation's `launch` starts
`node --import tsx packages/agent-bridge-acp/src/main.ts` locally (a production
deployment bundles the same entry) with this environment:

| Variable | Meaning |
| --- | --- |
| `AGENT_BRIDGE_ACP_PROVIDER` | Provider id in the registration declaration (default: dialect id). |
| `AGENT_BRIDGE_ACP_DIALECT` | `generic`, `amp` or `copilot`. |
| `AGENT_BRIDGE_ACP_COMMAND` | Installed ACP executable (`copilot`, `amp-acp`, …). |
| `AGENT_BRIDGE_ACP_ARGS` | JSON array of arguments (for example `["--acp"]`). |
| `AGENT_BRIDGE_ACP_CWD` | Default agent working directory; `session/create.cwd` overrides it. |
| `AGENT_BRIDGE_ACP_ENV` | Optional JSON object merged into the agent environment. |
| `AGENT_BRIDGE_ACP_PERMISSION_MODE` | Default `read-only`, `accept-edits`, `auto` or `full`. |
| `AGENT_BRIDGE_ACP_MODEL` | Optional model selector: Copilot model id, Amp mode key, or a generic model config value. |
| `AGENT_BRIDGE_ACP_MIN_VERSION` | Registration's minimum native version. |
| `AGENT_BRIDGE_ACP_PROBE_BASIS` | Registration's probe basis string. |
| `AGENT_BRIDGE_ACP_TRACE` | Optional private NDJSON wire trace path for acceptance recordings. |

The same artifact can therefore serve a Copilot generation, an Amp generation
or a deterministic fixture. The registration declaration is built with
`declarationFor(profile)`; a deployment must register that declaration as the
immutable upper bound.

## Capability handshake

`initialize` performs a real ACP `initialize` probe against the installed agent
and narrows the registered declaration:

- `native-inject` survives only when the dialect permits it **and** the agent
  declares `_meta.midTurnSteering === true` (top-level or
  `agentCapabilities._meta`). Copilot 1.0.102 declares neither, so it only gets
  `next-turn` and `interrupt-replace`.
- `inputContentTypes` / steer content types include `image` only when the agent
  declares `promptCapabilities.image`.
- Only `admission` is declared: ACP gives a prompt admission, not proof that
  the next model request contained the text, and text echo is not a stable
  per-input identity.
- `history` survives only when ACP `loadSession` or
  `sessionCapabilities.resume` is declared. `model/list` is declared; it reads
  the ACP model catalog or a model-category config option. A call to an
  undeclared method is refused by the Host gate and by the bridge.

Each `session/create` starts a new agent process, runs ACP `initialize` and
`session/new`, applies the permission/model plan, then emits `thread/identity`.
Session-level capabilities (native steering, images) may narrow further; they
never widen the handshake.

## Commands

All commands receive the Host-added `threadId` (the durable route key) and
`executionEpoch`; the bridge treats `threadId` as opaque.

| Method | Params | Result |
| --- | --- | --- |
| `initialize` | P1a handshake | effective capabilities |
| `session/create` | `{cwd?, permissionMode?, modelSelection?}` | `{providerThreadId, permission, model, capabilities}` |
| `session/resume` | `{providerThreadId?, nativeSessionId?, cwd?, permissionMode?, modelSelection?}` | `{providerThreadId, permission, model, capabilities, history?, resumed:true}` |
| `model/list` | `{threadId?}` | `{models, current, source}` from ACP models or a model config option |
| `history/read` | `{cursor?, limit?}` | paginated native replay updates from the resume/load window |
| `session/close` | `{}` | `{closed}`; cancels, emits `session.ended`, kills the agent |
| `turn/start` | `{input:{text, images?}, inputId?, clientRequestId?, permissionMode?}` | `{nativeTurnId, inputId}` |
| `turn/steer` | `{inputId, clientRequestId, input:{…}, expectedTurnId?, delivery?}` | `{nativeTurnId, delivery, …}` |
| `turn/stop` | `{}` | `{cancelled}`; cancels the active turn, withdraws queued inputs and a pending replacement; a written prompt becomes unknown |
| `input/query` | `{inputIds?}` | per-input facts |
| `input/withdraw` | `{inputId}` | `{state, outcome}` |
| `interaction/resolve` | `{interactionId, result}` | `{resolved, duplicate?}` |
| `maintenance/probe` | `{}` | recorded ACP initialize result and effective capabilities |

Images are accepted as up to 8 `{mimeType, data}` base64 blocks
(`image/png`, `image/jpeg`, `image/gif`, `image/webp`) within the declared
`contentLimits.maxBytes`; the Host also caps the whole command at 512 KiB. If
the selected agent did not declare image support, an image input is refused
instead of being silently converted to a path or text.

`expectedTurnId`, when present, must equal the `nativeTurnId` returned by
`turn/start`. The bridge does not know the assembler's canonical turn id; a
future gateway projection maps canonical→native before calling the bridge.

## Steer paths and evidence

The bridge never chooses a destructive fallback on its own:

- `native-inject` is the default **only** when the instance declared it. The
  bridge sends a concurrent ACP `session/prompt` to the active session. A
  successful ACP reply records `input.delivery = native-inject`, admitted, and
  `input.evidence = admission`. ACP has no stable per-input id and text echo
  cannot identify which prompt produced it, so this bridge deliberately does
  not emit echo evidence. This is admission, not context proof.
- `next-turn` must be requested explicitly. The bridge queued the input, and
  once the active turn settles it opens a new turn and emits `input.accepted`
  with the new native turn id and `disposition: "next-turn"`. Only after the
  new native prompt succeeds does it emit `input.delivery = next-turn` and
  `admission`; a failed prompt emits `input.outcome = unknown` and is never
  labelled admitted. It is never labelled `native-inject`.
- An interrupt replacement that has not been written yet is withdrawable, and
  `turn/stop`/`session/close` remove it before it can start a new turn. Once
  its native prompt is written, withdrawal is too late and a failed/stopped
  prompt is unknown, not admitted.
- `interrupt-replace` must be requested explicitly. The bridge sends ACP
  `session/cancel`, waits for the active prompt to settle, then opens a new turn
  and records `input.accepted.disposition = "interrupt-replace"`; on prompt
  success it records `delivery = interrupt-replace`. Before that prompt is
  written, `input/withdraw`, `turn/stop` and `session/close` discard it. If the cancel cannot be written,
  the input stays unknown and is not sent.
- Omitting `delivery` on an instance without native steering is an explicit
  rejection that tells the caller to choose `next-turn` or
  `interrupt-replace`. This is what keeps Copilot from showing a fake native
  steer success.
- A session without a stable native input id allows at most one unsettled
  native steer. Late replies after an `unknown` outcome are ignored; the native
  request is never replayed.
- `input/withdraw` only withdraws an undispatched input: a queued next-turn
  input or a pending interrupt replacement. A native prompt already written is
  `too-late`.

## Permission modes

The requested mode is applied to the agent's advertised session mode/config
options; undecided permission requests go through the existing interaction
channel as `interaction/request` with kind `approval`. The payload contains the
existing `item/commandExecution/requestApproval` method/params shape (so a
gateway can project it unchanged), the native ACP options, and the applied
policy. `interaction/resolve` accepts either `{decision:"accept"|"decline"}`
or an explicit `{optionId}`; unknown option ids cancel, never guess.

| Mode | Applied behavior |
| --- | --- |
| `read-only` | Auto-allows read/search/fetch/think tool permissions, denies edit/delete/move/execute; uses a native read-only mode when advertised. A denied request with no reject option is cancelled, never routed to a human as an approvable write. |
| `accept-edits` | Auto-allows edit/delete/move permissions, asks for other tools; uses a native accept-edits mode when advertised. |
| `auto` | Routes every permission request to the human interaction channel; uses a native auto mode when advertised. |
| `full` | Auto-allows every permission request; applies the dialect's full/bypass mode/config option when available. The underlying agent's own sandbox is never widened by this bridge. |

The session/create result carries the plan (`requested`, `approvalPolicy`,
`nativeModeId?`, `configOptions`, `detail`) so callers can see what was actually
applied. For example, Copilot uses `allow_all=on|off`, Amp uses
`permission=bypass|default`, and generic agents use advertised session modes.

## ACP client-side services

The bridge advertises `clientCapabilities.fs`, `terminal` and `elicitation`
for the services it implements. Authorization is enforced per Turn, not by
withholding the capability: a downgrade revokes writes/terminals and kills
existing terminals, an upgrade takes effect without reinitializing the agent.

- `fs/read_text_file` and `fs/write_text_file` stay inside the session cwd;
  symlinks and path escapes are rejected. Read-only sessions can read but not
  write. `accept-edits` and `full` can write; `auto` cannot, because its edits
  are still human-approved.
- `terminal/*` is advertised only in `full` mode and runs a bounded child in
  the session cwd with a 512 KiB output cap and at most eight terminals.
  `terminal/create/output/wait_for_exit/kill/release` are implemented; closing
  the session kills every terminal.
- `elicitation/create` is routed through the existing
  `interaction/request` channel as kind `elicitation` with an
  `item/elicitation/request` payload. Unknown or undeliverable elicitations
  cancel or decline; they never fabricate an answer.
- `mcp/*` is still unsupported and not advertised.

Native history is **replay**, not a second client history system. Resume/load
collects the ACP update stream from the load request until the first turn
starts (a 200 ms quiet window is used for the resume summary) and
`history/read` serves that replay. Late replay updates never become live turn
deltas, and the bridge does not claim history before a successful load.

## Dialect extension point

`dialect.ts` exports `AcpDialect`, `registerAcpDialect` and
`resolveAcpDialect`. A later pinned adapter (DSH, CodeBuddy, Cursor, AGY) adds a
dialect module that can:

- narrow/authorize native steering based on its own initialize metadata,
- map permission modes to its native modes/config options,
- map a model selector,
- handle a provider-private inbound client method.

A dialect cannot widen the registration declaration. It must add only facts
the probe established and must keep the same admission-only evidence model.
Dialect modules are part of the pinned bridge artifact; loading an arbitrary
module from an environment variable is deliberately not supported.

Current dialects:

- `generic`: ACP only; native steering only from `_meta.midTurnSteering`.
- `amp`: native steering from Amp ACP's `_meta.midTurnSteering`; concurrent
  prompt injection (the user's amp-acp native steer behavior); permission
  config `default|bypass`; `amp-mode` model selector (`low` is the cheapest).
- `copilot`: no native steering (1.0.102 has no local ACP native path);
  permission config `allow_all`; `model` config selector.

## Failure boundaries

- The bridge never resends an ACP prompt after a write-then-EOF, timeout or
  ambiguous error. A pending steer becomes `unknown`; the turn closes as failed
  with a `provider.recovery` hint and the native request must be queried, not
  replayed.
- ACP frames are bounded (16 MiB inbound); an invalid or oversized frame closes
  the agent instead of desynchronizing the session.
- Agent stderr is diagnostic only and never enters protocol or durable events.
- A write to a dead agent closes the connection and is diagnostic only; it is
  never retried as a new prompt and never becomes an unhandled rejection.
- `session/resume` uses ACP `session/load` when `loadSession` is declared and
  `session/resume` otherwise. A mode/config change that the agent forbids after
  the first prompt fails explicitly; the bridge does not pretend the mode was
  changed.
- `model/list` uses the live session catalog when one exists. A cold probe
  starts a short ACP `session/new` only for agents that declare
  `sessionCapabilities.close`; otherwise it returns `source:"requires-session"`
  rather than orphan a provider session. It never sends a prompt or consumes
  model tokens.
- History replay is bounded to 1,000 updates / 4 MiB. A single update over
  256 KiB is dropped and marked truncated; pages are capped at 512 KiB so they
  fit the Host wire. The Web client does not consume the P3 steer-evidence
  extension yet; the projection check is component-level.

## Local validation

```sh
npm run typecheck --workspace @opencraft/agent-bridge-acp
npm run test:agent-bridge
npm run check:boundaries
```

`tests/agent-bridge/acp.test.ts` uses `tests/agent-bridge/fixtures/acp-agent.mjs`
as a deterministic native transcript and covers initialize narrowing, image
gating, permission approval/decline/auto policies, native admission, explicit
next-turn, explicit interrupt-replace, withdrawal, duplicate resolve and agent
exit→unknown. `tests/agent-bridge/acp-host.test.ts` composes the bridge with the
P1b Host, command ledger/outbox and assembler.

Real-account acceptance through `apps/agent-bridge-host` uses
`scripts/smoke/agent-bridge/p3c-real-host.ts --agent copilot|amp` (recorded
under `design/agent-bridge/recordings/p3c/`). It consumes real quota, runs one
temporary file write, one steer, then closes/resumes the native session and
reads native history. The earlier direct-bridge acceptance remains under
`design/agent-bridge/recordings/p3/`. Neither script is part of CI.

The Web presentation check is
`scripts/smoke/agent-bridge/p3c-web-presentation.ts`; it renders the existing
`UserMessageBlock` for the Copilot normal-user-message shape and the Amp
steering shape, asserts no native/inject/fake-steer label, and writes a
screenshot. It does not claim a Host→AppServer→Web end-to-end path because the
existing Workbench does not consume `opencraft/steerEvidence/updated` yet.
