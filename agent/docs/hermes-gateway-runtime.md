# Managed Hermes Gateway Runtime

`hermes-gateway` is an independent managed Runtime that hosts the headless
Hermes TUI Gateway JSON-RPC server. It does not scrape the visual TUI and it
does not replace Hermes ACP.

## Temporary cloud identity

The internal Runtime identity is `hermes-gateway`. The current hosted Vela
baseline has no first-class Hermes Gateway value, so the registration
temporarily uses wire identity `pi`:

```text
opencode -> hermes-acp
pi       -> hermes-gateway
```

This is compatibility debt, not a claim that Hermes is Pi. The hosted UI may
label the selection as Pi. A real Pi Driver must not be registered until this
alias is removed or the platform provides a distinct Hermes wire identity.

The compatibility firewall strips Pi-owned provider credential keys from the
child process environment. The current frozen deny-set includes
`DEEPSEEK_API_KEY`. The Driver never edits the managed Hermes Profile to
translate Pi configuration. `default` preserves the Profile's configured
model; any non-default model must exactly match the live Gateway
`model.options` inventory or startup fails.

## Process and Profile model

Every launch uses the same deterministic native Profile as Hermes ACP:

```text
~/.hermes/profiles/vela-<first-32-hex-of-sha256-agent-id>
```

The Gateway process receives that directory as `HERMES_HOME`; the captured OS
user home remains `HOME`. Interpreter discovery accepts only an explicitly
configured Python or a Python proven to belong to the Hermes launcher
shebang/virtual environment. An unrelated system Python is not a fallback.

ACP and Gateway share protocol-neutral Profile provisioning and a
Profile-scoped lifetime lease. One Agent Profile can have only one ACP or
Gateway process at a time. Different Agent Profiles can run concurrently.

## Session and turn lifecycle

Startup is ordered:

1. validate the Hermes launcher and Python Gateway module;
2. provision the Agent Profile and acquire its lifetime lease;
3. start `python -u -m tui_gateway.entry`;
4. wait for `gateway.ready`;
5. read `model.options` and apply the model firewall;
6. resume a known durable session or create a new session;
7. submit the composed standing policy and current wake input.

The process-local `session_id` is launch-fenced and never persisted as the
Vela session. `stored_session_id`/`session_key` is the durable
`RuntimeSession.SessionID`. Only explicit RPC code `4007` (`session not found`)
permits a cold start; malformed success responses, permission failures,
transport failures, and other RPC errors fail startup.

Go Agent Manager remains the delivery queue of record. Hermes' native
single-item queued prompt is not used as a durable queue. The Runtime exposes:

- `NativeSteerer` through `session.steer`;
- `NativeTurnInterrupter` through `session.interrupt`;
- whole-process `Stop` separately through shutdown, pipe closure, signal, and
  bounded force-kill.

`message.delta` and `message.interim` are liveness/activity only. Exactly one
matching `message.complete` may publish canonical assistant text and one
`turn_completion`. Duplicate, foreign-session, stale-launch, and inactive-turn
completions are ignored. Unknown future events are tolerated.

## Headless interaction safety

The process has no native human UI, so blocking interaction requests are
resolved immediately and session-scoped:

- approval uses `HERMES_ACP_PERMISSION_POLICY` (`deny`, `once`, or `session`)
  and never escalates when the requested choice is unavailable;
- clarify receives a fixed instruction to ask through the current Vela
  conversation and wait for a later message;
- sudo, secret, and terminal-read requests receive empty responses;
- malformed or unknown blocking requests fail closed.

Diagnostics record only the interaction category and outcome. Questions,
commands, credentials, passwords, secret values, Profile content, and raw
environment values are not logged.

## Deliberate limits

- Local Hermes subagents remain activity inside their parent Vela Agent; they
  are not independent cloud Agents.
- The temporary Pi label is visible platform debt.
- The managed Profile is isolation and configuration ownership, not an OS
  security sandbox.
- Live rollout is a separate Canary gate after local full, race, vet, build,
  credential, and clean-room checks pass.
