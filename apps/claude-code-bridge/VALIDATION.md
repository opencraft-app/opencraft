# P2c local validation — 2026-11-11

Base: rebased onto `origin/main` `6d263ae20f` (P1b #213 and the daemon
baseline fix #214 are merged) in worktree `agent-bridge-p2c`, branch
`feat/agent-bridge-p2c`. No existing engine default, installed service,
gateway deployment or client route was changed. The old ACP Claude route was
not edited.

## Runtime requirement

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

## Results

| Command / probe | Result |
| --- | --- |
| `npm run typecheck --workspace @opencraft/claude-code-bridge` | passed |
| `npm run typecheck --workspace @opencraft/agent-bridge-host` | passed |
| `npm run typecheck` (workspace-wide) | passed |
| `npm run check:boundaries` | passed |
| `tsc -p packages/agent-bridge-protocol/tsconfig.json --noEmit` | passed |
| `tsc -p packages/agent-bridge-assembler/tsconfig.json --noEmit` | passed |
| `npm run test:agent-bridge` | 86 passed (57 P1b/P1a + 29 P2c) |
| `node --import tsx --test tests/execution/acp-engine.test.ts tests/execution/acp-host-handoff.test.ts tests/execution/independent-acp-host.test.mjs` | 48 passed; old ACP Claude route unchanged |
| `npm run build --workspace @opencraft/claude-code-bridge` | 1.6 MiB bundled ESM entrypoint |
| real-account smoke (below) | final post-rebase run completed; one turn, `Read`, steer `context-confirmed`, `PINEAPPLE` asserted |

## Real-account minimal task

Command:

```sh
npm run build --workspace @opencraft/claude-code-bridge
CLAUDE_CODE_EXECUTABLE=/path/to/pinned/claude \
  node --import tsx scripts/smoke/execution/smoke-claude-bridge.ts
```

The script used the installed `claude` 2.1.321 through the Agent SDK, chose the
cheapest available model from `model/list` (`haiku`; available list was
`default`, `opus`, `fable`, `sonnet`, `haiku`), created one temporary directory
with `note.txt`, and ran one turn with a non-destructive `Read` tool call and
one steer. It did not use `bypassPermissions`; the session allowlist was
`allowedTools: ["Read"]`.

Observed across four attempts with the same result shape: the first reached a
completed model turn but failed only in the script's final cleanup call; the
next three ran the whole script end to end, including the final post-rebase run
with the stricter assertions. The script now asserts these facts instead of only
printing them:

- one `turn.started` and one `turn.completed`, status `completed`;
- completed tool item `Read`;
- initial input evidence `context-confirmed`;
- steer evidence `context-confirmed` (`nativeInputId`/`evidenceRef` equal to the
  client UUID stamped on the SDK user message);
- final answer contained `PINEAPPLE`;
- Host command custody: `session/create`, `turn/start`, `turn/steer` and
  `session/close` all `accepted`; the Thread was released after ack.

Evidence grade: **context-confirmed** for the real steer on CLI 2.1.321. The
UUID was available and the bridge verified it; this is not an admission-only
claim. The run consumed one cheap Haiku turn per attempt (four attempts: the
first reached a completed turn and only the script's final cleanup call was
wrong; the next three validated the whole script, including the final
post-rebase run with the stricter assertions).

## Deterministic coverage for races and gaps

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

## Gaps recorded honestly

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

## Implementation decisions

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
