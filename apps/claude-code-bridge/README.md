# Claude Code Agent SDK bridge (P2c)

Opt-in bridge between the P1b independent Engine Host and a real Claude Code
process through `@anthropic-ai/claude-agent-sdk` streaming input. It does not
replace the existing ACP Claude route, is not the default engine for any
thread, and is not registered by the Server. A thread uses it only when the
Host is given this pinned generation and a `session/create` command.

## What this bridge owns

- one SDK `query()` per Thread with an async input stream;
- `turn/start`, `turn/steer`, `turn/stop`, `session/create`, `session/close`,
  `input/query`, `input/withdraw`, `model/list` and `maintenance/probe`;
- translation of SDK assistant/user/result/system messages into the P1a
  semantic deltas (`turn.*`, `item.*`, `input.*`, `usage`, `contextWindow`,
  `session.ended`, `provider.recovery`);
- per-input admission/evidence state. It never assembles client events.

The P1b Host still owns SQLite, the outbox, command custody, generations and
sandbox cleanup. The P1a assembler still owns canonical turn/item ids, ordering
and AppServer projection.

## Build and run

```sh
npm run typecheck --workspace @opencraft/claude-code-bridge
npm run build --workspace @opencraft/claude-code-bridge
```

`dist/claude-code-bridge.mjs` is a bundled entrypoint. The Claude Code CLI is
not part of that bundle: the bridge resolves an installed `claude` and passes
it as `pathToClaudeCodeExecutable`. It does not run the platform binary shipped
inside `@anthropic-ai/claude-agent-sdk`.

Add it to the Host as a generation whose `artifact` is that absolute file, whose
SHA-256 digest is pinned, and whose `launch.command` includes the artifact.
`CLAUDE_BRIDGE_DEBUG=1` writes callback diagnostics to stderr; stdout is only
JSONL protocol.

```json
{
  "id": "claude-sdk-1",
  "artifact": "/absolute/path/claude-code-bridge.mjs",
  "digest": "<sha256>",
  "provider": { "...": "CLAUDE_BRIDGE_DECLARATION" },
  "launch": {
    "command": ["/usr/bin/node", "/absolute/path/claude-code-bridge.mjs"],
    "cwd": "/absolute/workspace",
    "env": { "CLAUDE_CODE_EXECUTABLE": "/absolute/path/claude" }
  }
}
```

`CLAUDE_CODE_EXECUTABLE` is optional. When it is unset, the same resolver used
by session startup and the `model/list` initialize probe checks `PATH`
(`claude`, or `claude.exe` on Windows) and then the current platform's common
install locations: `~/.claude/local`, `~/.local/bin`, and the npm global bin
(`npm_config_prefix` or `npm prefix -g`). If the variable is set, it must point
at an executable file; a missing or non-executable path fails immediately and
does not continue the search. If no CLI is found, startup fails with an error
that tells the operator to install Claude Code or set `CLAUDE_CODE_EXECUTABLE`.
Command `env` still cannot override that variable or `PATH`.

The existing ACP Claude route (`claude_` threads through the independent ACP
Host and `@agentclientprotocol/claude-agent-acp`) is untouched. Both routes
speak AppServer; neither shares a native writer for the same thread.

## Command parameters

The Host passes `threadId` as the opaque route pair and injects
`executionEpoch`. Session-scoped params:

| Command | Params |
| --- | --- |
| `session/create` | required `cwd` (absolute Thread workspace verified by the Server/Host), optional `model`, `permissionMode` (`default`, `acceptEdits`, `bypassPermissions`, `plan`, `dontAsk`), `allowDangerouslySkipPermissions`, `allowedTools`, `disallowedTools`, `maxTurns`, `env`, `systemPromptAppend` |
| `turn/start` | `inputId`, `clientRequestId`, `text`, optional `model`, `permissionMode` |
| `turn/steer` | `inputId`, `clientRequestId`, `text`, optional `expectedTurnId`, `deliveryMethod` (only `native-inject`) |
| `turn/stop` | none |
| `input/query` | optional `inputIds` |
| `input/withdraw` | `inputId` (declared `withdrawal: none`, so returns `unsupported`) |
| `model/list` | optional `cwd`, `model`, `env`; starts a short-lived CLI probe with no model turn |
| `maintenance/probe` | none; readable native/process facts only |

`turn/start` and `turn/steer` require both `inputId` and `clientRequestId`.
Repeating the same input id and content is idempotent and never pushes a second
native message. Reusing it with different content is an explicit rejection.

`bypassPermissions` is refused unless `allowDangerouslySkipPermissions: true`
is explicitly supplied, including on a later `turn/start` permission-mode
switch. Default permission mode and an explicit `allowedTools` allowlist are
recommended; the real smoke uses only `Read`.

Command-supplied `env` cannot override the pinned process-loader or redirect
surface: `CLAUDE_CODE_EXECUTABLE`, `PATH`, `NODE_OPTIONS`, `NODE_PATH`,
`LD_PRELOAD`, `LD_LIBRARY_PATH`, `DYLD_*`, `ANTHROPIC_BASE_URL` and
`HTTP(S)_PROXY`/`ALL_PROXY`/`NO_PROXY` are rejected. Put those in the generation
launch environment; `env` remains trusted-Server input for credentials and
config the caller explicitly scopes to the session. `cwd` is the
Server/Host-verified Thread workspace; the Host pool owns sandbox containment,
and this bridge does not derive a workspace from `process.cwd()` or add a second
path policy.

## Steer and evidence

Every steer gets a client-minted UUID stamped on the SDK user message. The
bridge emits:

1. `input.accepted` (registered; not delivered);
2. `input.delivery` with `native-inject`, `admitted: true` once the SDK input
   stream takes the message;
3. `input.evidence` with `admission` immediately, and `context-confirmed` only
   when the CLI reports the UUID back in a replay user message, an assistant
   first-reply stamp, or `result.user_message_uuids`/`user_message_uuid`.

Without those UUID fields (older CLI or a result that does not carry them),
the input stays at admission evidence. The bridge does not turn an echo or a
model sentence into context proof. `input/withdraw` is declared `none`; the SDK
input stream owns a message as soon as it takes it.

### Held turns and races

One serial queue handles commands and SDK messages, so the arrival order
decides a steer/end race:

- a steer admitted before the first result keeps the logical turn open;
  `turn.mainRun idle` is emitted at the result and the turn closes only after
  the steer's UUID is reported or its own result arrives;
- a steer after the turn settled gets `stale-target` with no native write;
- results with `queued_turn_count > 0`, live non-ambient background tasks
  (`task_started`/`background_tasks_changed`) or a pending steer keep the turn
  held; background task edges that are ambient, foreground or
  `skip_transcript` do not count as activity;
- `session_state_changed idle` is authoritative: it clears stale background
  membership and closes a turn with no pending steer, even if a bookend was
  missed; a bounded grace covers older CLIs without the idle signal;
- a `maxHoldMs` safety valve (10 minutes by default) settles an indefinitely
  held steer as `unknown` and closes the turn instead of wedging the Thread; a
  pinned-length input-admission timeout (15 seconds) fails closed as `unknown`
  when the SDK stops consuming the input stream;
- a steer admitted with no result or evidence within the safety window becomes
  `input.outcome unknown`, not a fake success, and the turn closes; later
  evidence may still upgrade the input;
- Stop sends `cancelQueued: true` (older CLIs ignore it and report survivors in
  the interrupt receipt). A pending steer that the native cancelled becomes
  `failed`; a survivor or ambiguous one becomes `unknown`; none are mislabelled
  as withdrawn. The turn closes as `interrupted` and a late result cannot close
  it twice.

A background task wake in a real Claude process was not exercised by the real
account smoke; it is covered by a deterministic SDK-message fixture.

## Declared capabilities

`model`, `usage`, `steer` (native-inject) and text input are declared.
`history`, `session/resume`, approvals, reasoning selection, fork/checkpoint,
skills and installation are not. The native session id is reported on
`thread/identity` with `sessionRestorable: false` until those paths exist.
The declaration is an upper bound. Runtime UUID support does not change the
effective capability set; it only decides whether an input can reach
`context-confirmed` or must stay at admission evidence.

`minNativeVersion` is `2.1.321`, the version used for the real smoke. The
bridge feature-detects rather than refusing an older CLI; older CLIs simply
stay at admission evidence. The bridge still depends on
`@anthropic-ai/claude-agent-sdk` for the session API, but the CLI it runs is the
resolved install, not that package's optional platform binary. The dependency is
Anthropic's proprietary package (not Apache-2.0); public distribution of the
bundled artifact needs a license review.

## Tests

- `tests/agent-bridge/claude-executable.test.ts` — installed CLI resolution
  (valid pin, invalid pin, `PATH`, a common install location, and no CLI).
- `tests/agent-bridge/claude-session.test.ts` — pure state machine with a
  scripted native port (steer/end race, held background turn, no-UUID fallback,
  timeout, EOF, idempotence, usage/tool translation).
- `tests/agent-bridge/claude-protocol.test.ts` — JSONL framing, handshake,
  capability gating and a full session path.
- `tests/agent-bridge/claude-host.test.ts` — real P1b Host + this protocol
  server + assembler with a scripted SDK; stale steer settles `rejected`.
- `tests/agent-bridge/fixtures/claude-steer-race.json` — native transcript
  fixture for the held-turn decision.
- `scripts/smoke/execution/smoke-claude-bridge.ts` — manual real-account smoke.
