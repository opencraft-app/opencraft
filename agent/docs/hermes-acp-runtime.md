# Managed Hermes ACP Runtime

`hermes-acp` runs one Hermes ACP subprocess for one active Vela Agent launch.
It is a managed Computer Runtime, not the external Vela CLI wake bridge.

## Platform configuration

The internal Driver identity is `hermes-acp`. The current hosted Vela baseline
does not expose arbitrary Runtime IDs in its Agent creator, so this build uses
the otherwise unused `opencode` wire slot for compatibility. The Web UI will
temporarily label the Runtime as OpenCode even though the Computer starts
Hermes ACP.

Select OpenCode on this specific Computer. The Computer derives and provisions
the Hermes Profile; the cloud configuration does not select it:

```json
{
  "runtime": "opencode",
  "runtimeConfig": {
    "version": 1,
    "runtime": "opencode",
    "model": {
      "kind": "preset",
      "id": "default"
    },
    "mode": {
      "kind": "default"
    },
    "envVars": {
      "HERMES_ACP_PERMISSION_POLICY": "session"
    }
  }
}
```

Each Vela Agent gets one native Hermes named Profile:

```text
~/.hermes/profiles/vela-<first-32-hex-of-sha256-agent-id>
```

On first start the Driver runs the selected Hermes executable with
`profile create <name> --clone --clone-from default --no-alias`. It then
removes only the two legacy identity files that older Hermes clone behavior
may copy, verifies fresh Runtime state, and writes a restricted ownership
marker. Stop, restart, reconnect, and Computer restart reuse the same Profile.

ACP and Hermes Gateway may both use this Profile across different launches,
but never simultaneously. A Profile-scoped process lease is acquired after
provisioning and released only after the native process is reaped. Different
Agent Profiles remain independently concurrent.

Cloud or inherited `HOME`, `HERMES_HOME`, and `HERMES_PROFILE` values cannot
redirect a managed launch. The Driver captures the OS-user home, ignores
Hermes' sticky `active_profile`, removes those selectors from the child
environment, and starts `hermes --profile <managed-name> acp`.

The native Profile and Vela workspace remain separate. Runtime-home skill
discovery uses the Agent's managed Profile while ACP `cwd`, tool execution, and
workspace APIs use `~/.vela/workspaces/<agentID>`.

## Managed launch behavior

The Driver:

1. validates `hermes acp --check` and the required native Profile-create
   flags;
2. rejects container installs in this release, provisions or validates the
   Agent-owned native Profile, and starts
   `hermes --profile <managed-name> acp`;
3. negotiates ACP wire protocol version 1;
4. loads the previous ACP session when supported, otherwise creates a fresh
   session and emits a recovery event;
5. sends prompts and normalizes assistant, thought, tool, usage, command,
   plan, completion, diagnostic, and error events;
6. coordinates the initial prompt and busy-turn redirect prompts as one
   response-driven prompt family;
7. sends `session/cancel` before process termination.

ACP `session/prompt` responses are the only turn-completion authority. The
initial prompt is the family root. Redirect prompts accepted while the root is
active become ordered children. A child response received before the current
root is only an acknowledgement: it removes that child but does not complete
the cloud turn. When the current root responds, the oldest unresolved child is
promoted. Exactly one `turn_completion` is emitted after the root and every
accepted child have responded.

Every prompt write is classified before delivery is acknowledged:

- a proven zero-byte write is unsent and may be retried;
- a complete frame is committed, even if the writer also reports an error;
- a partial frame is ambiguous and terminates the ACP transport.

Committed and ambiguous writes are never silently replayed. Stop and terminal
transport failure fence completion before cancellation, so delayed responses
from the old process cannot return an Agent to idle or complete a newer launch.
The Driver owns all ACP pipes, reaps the process, and applies bounded stdout and
stderr drain grace periods so inherited descendant file descriptors cannot
leave the Agent permanently Thinking.

ACP session history emitted while `session/load` is running is suppressed so
old assistant text is not reported as a new cloud reply.

Every launch inherits the same Computer capability environment as Codex,
including the generated `vela`/`Vela` wrapper and loopback gateway. Inherited
`VELA_PROFILE` and `VELA_PROFILE` are removed before Hermes starts so an
external wake-bridge login cannot override launch-scoped Computer identity.

Each Computer-managed Hermes Profile also owns a reserved
`skills/vela/SKILL.md`. The provisioner creates or repairs that Skill before
Runtime startup so Hermes can discover the launch-scoped inbox/read/send
workflow instead of relying only on standing-prompt hints. The file contains
no credentials or host paths. A non-managed Skill already occupying the
reserved `vela` name is treated as a collision and is never overwritten.

## Permission policy

`HERMES_ACP_PERMISSION_POLICY` controls ACP permission requests:

- `session` (default): prefer an `allow_session` option, then `allow_once`;
- `once`: select only `allow_once`;
- `deny`: cancel the request.

This is a non-interactive server policy. The Driver never silently upgrades a
denied capability.

## Compatibility and limits

- Hermes ACP is advertised in `ready` only when the local compatibility probe
  succeeds. Against the current hosted baseline, the advertised wire value is
  `opencode`; the internal Driver and diagnostics remain `hermes-acp`.
- Model detection currently exposes the selected profile's configured default,
  because ACP does not provide a portable model catalog.
- The default `~/.hermes` Profile must exist. Its `.env` configuration is
  cloned once. OAuth-only providers depend on compatible Hermes builds'
  read-only default `auth.json` fallback; the Go Driver never parses or copies
  that credential database.
- This release supports host-installed Hermes on macOS and Linux. It rejects
  known container-install signals before native Profile creation because
  current container Profile creation can have s6 gateway side effects.
- Managed Profile ownership is transactional and fail-safe. An unmanaged
  directory at the deterministic name, an invalid marker, or an ambiguous
  interrupted create is preserved and rejected rather than adopted or
  deleted.
- ACP unknown fields are accepted. Unsupported server requests receive a
  JSON-RPC method-not-supported response.
- Malformed ACP frames, impossible response IDs, and live-process stdout EOF
  are terminal transport failures. Known late response IDs are ignored after
  fencing.
- ACP stderr is discarded by default. Setting
  `VELA_TRACE_HERMES_ACP=1` retains only a bounded, redacted
  diagnostic tail for unexpected process failures; credentials and tokens are
  removed before an error reaches logs or activity.
- `VELA_PROFILE` remains reserved for the separate Vela CLI wake bridge and is
  intentionally unrelated to the managed Hermes Profile.
- Local mock-ACP tests cover initialization, profile selection, permissions,
  two concurrent Agent Profiles/workspaces, permissions, event normalization,
  every prompt-family response order, redirect acknowledgement, write
  commitment ambiguity, cancellation fencing, malformed frames, EOF,
  descendant-held pipes, forced process reap, dispatcher backpressure, session
  recovery, and history replay suppression.
  A real-cloud Canary remains a separate acceptance gate.
- When the hosted platform accepts `hermes-acp` directly, remove the Hermes
  registration's `WireID`; no runner or ACP implementation change is needed.
