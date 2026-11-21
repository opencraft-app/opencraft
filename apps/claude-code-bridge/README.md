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

## Design decisions and known limits

Carried over from the retired validation ledgers; evidence runs and review logs live in Git history.

### P2c: Runtime requirement

The bridge resolves one Claude Code CLI and passes it to every Agent SDK
`query()` as `pathToClaudeCodeExecutable`, including session startup and the
`model/list` initialize probe. It does not fall back to the SDK's optional
platform binary.

1. `CLAUDE_CODE_EXECUTABLE`, when set, must be an executable file. Otherwise
   the command fails and search does not continue.
2. `claude` on `PATH`. Windows looks for `claude.exe`.
3. Common locations for the current platform: `~/.claude/local`, then
   `~/.local/bin`, then the npm global bin.
4. If none of those exist, the error tells the operator to install Claude Code
   or set `CLAUDE_CODE_EXECUTABLE`.

Command `env` cannot override `CLAUDE_CODE_EXECUTABLE` or `PATH`. The historical
real-account smoke below pinned the CLI with `CLAUDE_CODE_EXECUTABLE`; that pin
still works.

### P2c: Deterministic coverage for races and gaps

`tests/agent-bridge/claude-session.test.ts` + `claude-host.test.ts` cover:

- steer admitted before result → held, then UUID-confirmed and closed;
- steer after settlement → explicit `stale-target`, no native push; Host settles
  the command `rejected` (small P1b settlement fix, also covered through the
  real Host);
- rejected first `session/create` → valid retry on the same Thread identity;
- replay/evidence before the steer result → held, not closed early;
- `session_state_changed running` → live follow-up survives the steer timeout;
- SDK idle is authoritative over stale/ambient background bookends;
- turn/start cannot switch to `bypassPermissions` without the create-time opt-in;
- command `env` cannot choose the executable or redirect the credential endpoint;
- one hung `model/list` probe cannot head-of-line block another Thread;
- older CLI without result UUIDs → one-result hold, then settle with
  admission-only evidence;
- background task result → held; `background_tasks_changed []` +
  `session_state_changed idle` → close;
- `queued_turn_count > 0` → held until the following result;
- steer with no evidence → `input.outcome unknown`, no fake success;
- stop → `cancelQueued`, pending steer `failed` if cancelled or `unknown` if it
  may survive; turn `interrupted`; late result cannot close twice;
- native EOF or stalled input admission → pending input `unknown`,
  `session.ended`, no queue wedge;
- duplicate input ids → idempotent, no second push;
- tool/text/usage translation and one-turn projection through the Host.

### P2c: Gaps recorded honestly

- The real steer was accepted while the first response was still streaming; it
  may have been folded into the same SDK turn. The multi-result held-turn path
  is therefore fixture-covered, not proven by the real run.
- A real background-task wake was not triggered in the real task; only the
  deterministic fixture covers `task_started`/`background_tasks_changed`,
  including ambient/foreground exclusion and idle authority.
- The 10-minute hold safety valve is fixture-covered, not real-time exercised.
- Stop's `cancelQueued` receipt and survivor settlement are fixture-covered; the
  real smoke did not press Stop.
- A blocked input admission at native EOF and a stalled admission timeout are
  fixture-covered; the real SDK normally consumes input promptly.
- The real steer was consumed without needing to exercise the bounded
  "no evidence" timeout; that path is fixture-covered.
- Host retry after a rejected create is fixture-covered through the real Host;
  the real smoke never attempted an invalid create.
- The old ACP Claude route was verified by its existing fixture/process tests
  (48 passed) and by not editing it. `@agentclientprotocol/claude-agent-acp`
  is not installed in this checkout, so no real ACP Claude model task was run in
  this batch. The real model task used the new SDK path.
- The real smoke used the test-only process-group backend to isolate the Host
  and bridge processes; kernel cgroup/rlimit constraints are not re-proven here
  (P1b's Linux sandbox smoke remains the authority).
- `history/read`, `session/resume`, approvals and reasoning selection are not
  implemented; they are declared unavailable rather than silently degraded.
- ACP old-path behavior and P1b Host behavior are unchanged except the
  stale-target settlement classification noted above.
- License: `@anthropic-ai/claude-agent-sdk` is Anthropic's proprietary package
  ("SEE LICENSE IN README.md"), not Apache-2.0. The bridge source is independent,
  but the built artifact embeds that SDK; any public distribution needs the
  maintainer's license review. The real CLI (`claude` 2.1.321) is likewise a
  vendor installation, not vendored source.

### P2c: Implementation decisions

- `session/create` sets an explicit SDK `sessionId` UUID and runs
  `initializationResult()` (a control request, no model turn) so native version,
  model catalog and the identity callback are available before the first turn.
- The bridge holds one logical turn across multiple SDK results when a steer or
  background work is outstanding; it does not emit a second canonical turn.
- Steer evidence is upgraded only from native UUID-bearing frames; admission is
  emitted separately and never flattened into context-confirmed.
- `withdrawal` is declared `none` because the SDK input stream takes ownership
  synchronously in `turn/steer`; claiming a pre-dispatch window would be false.
- The bridge bundle is built from source and pinned by the Host's artifact
  digest; `dist/` stays out of Git. The native Claude CLI is resolved from
  `CLAUDE_CODE_EXECUTABLE`, `PATH`, or a common install location. The SDK's
  optional platform package is not a runtime fallback.
