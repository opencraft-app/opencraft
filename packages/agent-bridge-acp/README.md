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
- `history`, `model/list`, `usage`, skills/installation/fork are not declared in
  P3; a call to an undeclared method is refused by the Host gate and by the
  bridge.

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
| `session/resume` | — | `unsupported` (P3 does not claim native history) |
| `session/close` | `{}` | `{closed}`; cancels, emits `session.ended`, kills the agent |
| `turn/start` | `{input:{text, images?}, inputId?, clientRequestId?, permissionMode?}` | `{nativeTurnId, inputId}` |
| `turn/steer` | `{inputId, clientRequestId, input:{…}, expectedTurnId?, delivery?}` | `{nativeTurnId, delivery, …}` |
| `turn/stop` | `{}` | `{cancelled}`; cancels the active turn and withdraws queued inputs |
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
  once the active turn settles it opens a new turn, emits `input.accepted` with
  the new native turn id and `disposition: "next-turn"`, then
  `input.delivery = next-turn` and `admission`. It is never labelled
  `native-inject`.
- `interrupt-replace` must be requested explicitly. The bridge sends ACP
  `session/cancel`, waits for the active prompt to settle, then opens a new turn
  and records `input.accepted.disposition = "interrupt-replace"` and
  `delivery = interrupt-replace`. If the cancel cannot be written,
  the input stays unknown and is not sent.
- Omitting `delivery` on an instance without native steering is an explicit
  rejection that tells the caller to choose `next-turn` or
  `interrupt-replace`. This is what keeps Copilot from showing a fake native
  steer success.
- A session without a stable native input id allows at most one unsettled
  native steer. Late replies after an `unknown` outcome are ignored; the native
  request is never replayed.
- `input/withdraw` only withdraws an undispatched queued input. A native prompt
  already written is `too-late`.

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
| `read-only` | Auto-allows read/search/fetch/think tool permissions, denies edit/delete/move/execute; uses a native read-only mode when advertised. |
| `accept-edits` | Auto-allows edit/delete/move permissions, asks for other tools; uses a native accept-edits mode when advertised. |
| `auto` | Routes every permission request to the human interaction channel; uses a native auto mode when advertised. |
| `full` | Auto-allows every permission request; applies the dialect's full/bypass mode/config option when available. The underlying agent's own sandbox is never widened by this bridge. |

The session/create result carries the plan (`requested`, `approvalPolicy`,
`nativeModeId?`, `configOptions`, `detail`) so callers can see what was actually
applied. For example, Copilot uses `allow_all=on|off`, Amp uses
`permission=bypass|default`, and generic agents use advertised session modes.

`elicitation/create` is declined explicitly in P3; `fs/*`, `terminal/*` and
`mcp/*` client methods are answered with `-32601` because this bridge does not
advertise those client capabilities.

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
- `session/resume`, native history and `model/list` are not implemented. A
  deployment that needs them must add the capability with a real probe and
  read port; declaring them without implementation is refused by review.

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

Real-account acceptance (recorded under
`design/agent-bridge/recordings/p3/`) uses
`scripts/smoke/agent-bridge/p3-real-acp.ts --agent copilot|amp --out …`. It
consumes real quota, runs one minimal task and one steer, and records the actual
ACP `initialize` request/response. It is not part of CI.
