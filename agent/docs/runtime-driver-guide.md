# Adding a built-in Runtime

The client uses compile-time Runtime registration. Codex app-server, Hermes
ACP, Hermes Gateway, and OpenClaw Gateway are the current built-in Runtimes. A new Runtime is
source-reviewed and shipped in the same binary; there is no dynamic plugin or
manifest loader.

## Required pieces

Create one package under `internal/<runtime>/` that owns:

- executable/SDK discovery and compatibility probing;
- model detection;
- a `runtimeapi.RuntimeDriver` and per-launch `RuntimeSession`;
- native protocol parsing and normalized `runtimeapi.Event` emission;
- a pure `runtimeapi.LaunchPlanner`;
- mapping native retryable delivery rejection into the generic runtimeapi
  delayed-idle or turn-boundary disposition;
- a `runtimeapi.Registration` with identity, factory, Runtime policy, and
  planner.

Add that registration to the explicit list in `internal/runtimes/builtins.go`.
Do not self-register from `init()`.

`Registration.ID` is the implementation identity used by the Driver-owned
planner. `Registration.WireID` is optional and should normally remain empty.
Use it only when a frozen cloud baseline requires a different accepted Runtime
name. The catalog then advertises and resolves the wire identity while
translating launch planning back to the internal identity. Wire identities
must be unique, must not be aliases for more than one Driver, and must be
documented as compatibility debt.

## Ownership boundary

Runtime packages own native behavior. The generic core owns scheduling:

```text
built-ins -> catalog -> immutable startup snapshot
                         |       |          |
                         v       v          v
                    Controller  Core  Agent Manager
```

- Controller resolves launch planning but retains credentials, buffered-message
  durability, and launch fencing.
- Core resolves ephemeral Drivers for model detection.
- Agent Manager resolves fresh launch Drivers and owns concurrency, queueing,
  status, retry timing, recovery, and normalized-event projection.

Do not add Runtime IDs or native method strings to Controller, Core, or Agent
Manager. Protocol compatibility, transcript formats, skill roots, and explicit
diagnostic/presentation tables may remain Runtime-specific outside scheduling
when their ownership is documented.

## Capability rule

Declare only policy the current generic core executes. If a new Runtime needs a
new lifecycle, readiness, recovery, or wake decision, first add a generic
runtimeapi contract, one real core consumer, and contract tests. Do not add
unused descriptor fields and do not hide the difference behind
`if runtime == ...`.

Native turn control is granular and optional:

- implement `runtimeapi.NativeSteerer` only when the native protocol has a
  tested active-turn steering operation;
- implement `runtimeapi.NativeTurnInterrupter` only when the native protocol
  can interrupt a turn without terminating the Runtime process;
- do not combine them into an all-or-nothing capability;
- `RuntimeSession.Stop` always means whole-process termination.

Codex implements native steering but not turn interruption. Hermes Gateway
implements both. Hermes ACP implements neither optional interface because its
redirect and cancellation behavior is owned by the ACP prompt-family state
machine rather than the Gateway turn-control contract.

Define one package-local policy function and use it only from the package's
registration:

```go
func runtimePolicy() runtimeapi.RuntimePolicy {
	return runtimeapi.RuntimePolicy{
		SupportsStdin: true,
		BusyMode:      runtimeapi.BusyDeliveryDirect,
		Completion:    runtimeapi.CompletionEvent,
	}
}
```

The catalog rejects incomplete or inconsistent policies before any Driver is
used:

| Field | Current values | Meaning |
| --- | --- | --- |
| `SupportsStdin` | `true`, `false` | Whether an active native session accepts delivery. |
| `BusyMode` | `none`, `gated`, `direct` | How the generic Manager schedules delivery while a turn is active. `direct` requires stdin support. |
| `Completion` | `event` | The Driver emits one authoritative `EventTurnCompletion` for each accepted native turn. |

Runtime packages translate their native protocol into this contract. They must
not independently publish cloud activity, manage the durable inbox, or infer
idle from process exit. Agent Manager snapshots retain the launch's immutable
policy, including across a live rebind, and the Runner projects normalized
completion to the cloud without inspecting the Runtime ID.

For persistent request/response protocols, the adapter must model the native
accepted-request lifecycle explicitly. Streamed text, process quiescence, and
process exit are not substitutes for an authoritative response. If one Vela
turn can create multiple native prompt requests, the adapter owns their
ordering and must emit exactly one normalized completion only after the whole
accepted request family reaches its native terminal boundary. Stop, reconnect,
and transport failure must fence delayed output from the old session.

## Standing prompt contract

The Runtime catalog composes every successful launch plan with the versioned
shared Vela conversation policy. This applies even when a registration supplies
a custom planner or a wire Runtime alias. A Driver may return additional
Runtime-specific standing instructions; the catalog preserves them before the
shared policy, whose conflict rules take precedence.

`RuntimeDriver.Start` must transport `StartRequest.StandingPrompt` semantically
intact to the native model on both start and resume paths. A Driver must not
drop it, replace it with current input, or recreate its own copy of the shared
policy.

Planner coverage alone is not sufficient because the Driver owns the native
wire. Every new built-in Driver must include a protocol-boundary test proving
that the complete standing prompt reaches the native start/resume request while
current input remains separate. Codex tests
`developerInstructions` on `thread/start` and `thread/resume`; Hermes tests the
Computer operating-instructions section of the first ACP `session/prompt`.

## Test checklist

- Registration validation and built-ins ordering.
- Separate factory instances for probe, model detection, and each launch.
- Probe/model cancellation and unavailable behavior.
- Exact launch/resume/wake planning and buffered-prefix consumption.
- Catalog composition of custom-planner standing instructions, including wire
  aliases and idempotent version-marker handling.
- Native start and resume wire propagation of the complete shared standing
  prompt.
- Deliver/Stop cancellation, stable session ID, and Events closure.
- Native-to-normalized activity, message, reasoning, tool, usage, completion,
  recovery, diagnostic, and error trajectories.
- Delayed-idle/turn-boundary rejection behavior where declared.
- Launch fencing, stale output suppression, restart, reconnect, and cleanup.
- Package, race, architecture, clean-room, credential, and platform build
  gates.

Keep fixtures sanitized and provenance-bearing. Recovered evidence may define
observable compatibility requirements but must never be imported into or
copied as implementation source.

## Proven shared boundary

Codex and both Hermes adapters now validate that the generic boundary is
practical:

- both register through `internal/runtimes/builtins.go`;
- both receive the same launch-scoped workspace, capability proxy, generated
  `vela` wrapper, identity, and environment;
- both use a persistent-process launch planner without leaking a concrete
  Runtime ID into Controller, Core, or Agent Manager;
- both transport the same catalog-composed standing policy through their
  native model protocol;
- both expose native sessions through `RuntimeSession`, normalized events,
  retry dispositions, liveness, and Runtime-home information;
- Runtime-home-driven skill discovery works for Codex home and each
  Agent-owned native Hermes Profile.

The shared boundary deliberately does not attempt to unify native protocol
details. Codex owns app-server JSON-RPC and turn steering. Hermes ACP owns its
ACP prompt family, permission decisions, redirects, and history replay
suppression. Hermes Gateway owns TUI-Gateway JSON-RPC, native steer/interrupt,
and deterministic headless interaction replies. Both Hermes adapters share
only protocol-neutral Profile preparation and the per-Profile process lease.
Generic scheduling still sees only the
`RuntimeDriver`/`RuntimeSession` contracts. A future adapter should follow the
same split.
