# P6 AGY hook / IPC / native trace

Opt-in `agy` dialect in the existing ACP bridge. Default routes and Hermes are
unchanged. Native AGY 1.5.5 supplies ACP sessions, tools, permissions, models and
output; OpenCraft independently implements the user's hook/IPC/evidence patch.
It does not run or import the old antigravity-acp wrapper.

## Implementation and evidence

`src/agy.ts` owns one private 0700 Unix-socket directory per native ACP process,
an unguessable owner token, the active native session and at most one unsettled
steer. The installed `agy-acp-steer` plugin must be enabled with both lifecycle
hooks and its command source present. A readonly native schema/payload sample
must validate before initialize/session capabilities advertise `native-inject`
and `native-input-id`. Windows never advertises this Unix path.

The hook receives text via `/claim`, returning `injectSteps` (and
`force_continue` after an invocation). That response alone emits no delivery or
native evidence. The claim records both `initialNumSteps` (minimum 1) and the
pre-injection maximum native row index. A Worker independently queries native
`steps`, decodes only the raw protobuf user fields and requires step type 14,
an exact unique text match, `idx >= floor` and `idx > baseline`. The native
identity is `(conversationId, idx)`. Evidence stops at the original prompt
response boundary, Stop, EOF and close; async Worker replies carry the turn
generation and cannot affect a later turn. No automatic cancel, followup or
prompt replay occurs after an uncertain result.

Same text as the initial prompt, an earlier attempted steer, any pre-existing
raw user row, or multiple matching rows stays `unknown`. ACP echo never counts.
This proves the native trace boundary, not model understanding. Missing rows,
read/schema failures and unfinished hook work settle unknown without replay.
The foreign AGY database is never opened by an OpenCraft migration owner and is
never written. SQLite imports, queries and binary decoding are confined to
`agy-trace.worker.mjs`; its lifecycle is owned by the connection. The main
thread only awaits messages. The source asset must accompany a bundled bridge.

## Source boundary

Read-only source baseline: antigravity-acp `3b4b7bde3d003b7400c4601e4579dbbb7c8a2967`,
user author `hxy91819 <masonxhuang@proton.me>`. Inspected user patch paths:
`plugin/*`, `src/acp/steering.ts`, steering hunks in `src/acp/adapter.ts` and
plugin detection in `src/agy/process.ts`. Only the hook wire protocol, FIFO
intent and raw-row/floor matching semantics are carried over. No upstream
runner, database reader, generated protobuf decoder or AGY implementation is
copied. The small protobuf wire reader is independently implemented from the
observed field layout (StepPayload field 19; UserPrompt fields 2/3; nested text
field 1). Own plugin sources are bundled under `plugin/agy`; this acceptance
uses the already installed user's plugin, without modifying it.

## Real Host acceptance

[Successful sanitized recording](recordings/p6/agy-host.json): AGY 1.5.5,
`gemini-3.8-flash-low`, one temporary task (`sleep 8`) and one steer through
`apps/agent-bridge-host`. Steer was sent between native tool start and tool
completion (wire indices 15 < 16 < 17). One hook claim; new raw user row 3,
floor 1, pre-injection maximum 2; exact text matched; one original ACP prompt,
no prompt replay; canonical projection verified as `context-confirmed`.
The recording includes a post-run readonly Worker excerpt of the two native
raw user rows, their SHA-256 text digests, an opaque conversation id and the
canonical input proof. The new row digest equals the steer input digest. This
extract used the existing native database, with no new model invocation. No
user/account content or machine paths are retained.

The model was selected from the live native catalog: the low-effort Flash
variant, below the available Sonnet/Opus choices. AGY supplies no numerical
price table, so a global price comparison against GPT-OSS is not established.
The test uses the existing Host local-test backend: this verifies actual Host
custody, provider and assembler, **not production cgroup isolation**.

[Restricted attempt](recordings/p6/agy-host-restricted.json) is retained as a
failed attempt, not upgraded evidence: four hook calls, one steer registration,
zero raw-user proofs; no matching native task trace persisted in the restricted
home directory. A separately authorized unrestricted execution used a fresh
temporary session, not replay of the uncertain steer. No existing session,
plugin installation, default engine, service or private downstream changed.

## Deterministic validation

`tests/agent-bridge/agy.test.ts` uses a separate native fixture process and real
Worker/SQLite reads: success, identical text, duplicate raw rows, wrong floor,
echo without insertion, schema drift, absent plugin, EOF, late row after native
end, Stop, invalid content, Windows declaration and worker failure. An exclusive
native database lock keeps main-thread timers running. Source guards keep
SQLite imports out of the main connection/adapter/bridge.

Final frozen-source checks (2026-11-11), rerun using this checkout's independent
`npm ci --ignore-scripts` dependencies:

- `npm run test:agent-bridge`: **10 consecutive runs, 210/210 each**, zero
  failures, skips or cancellations (includes all 13 AGY cases).
- Root `npm run typecheck`: passed across workspaces and Git identity scripts.
- `npm run check:boundaries`: passed, including typography, hover and controls.
- `git diff --check` and recording JSON/path checks: passed.

The inherited exported `BASH_FUNC_which%%` Bash function was removed from test
command environments, following the existing P4 validation convention. No
production environment validation was weakened.

## Independent review

`bb-dispatch --difficulty simple` selected the configured CodeBuddy `hy4std`
reviewer, thread `thr_ybuq6ukt66`. It reviewed the complete frozen-source diff
`origin/main..10509afe17` (18 files) and the three supplemental recording/smoke/
validation changes. The reviewer reported **zero P0/P1 findings** and
`patch is correct` (confidence 0.8); no P1 fix remains. It independently checked
the recorded text digests and surrounding ACP lifecycle/gating code. This was
a static read-only review; its result does not claim another model run or
another test execution. Final tests above were run by this implementation
thread using checkout-local dependencies.

## Decisions introduced here

- Use installed AGY's native ACP instead of carrying an upstream Bun ACP runner.
  The user's hook wire protocol remains compatible with the installed plugin.
- Add the pre-claim row maximum in addition to the user's floor check; an old
  row cannot become evidence just because a hook supplies a lower floor.
- Treat repeated text across this run as unknown, including previously settled
  steers. Do not invent a per-input native id from text or hook ids.
- Fail capability probing if no validated native user/schema sample exists;
  do not create an empty AGY database to make the probe pass.
- Keep a standalone native Worker source asset beside the bridge, using Node's
  builtin readonly SQLite; no new third-party database dependency is added.
- Keep the failed restricted attempt as separate evidence and use a fresh
  temporary session for the corrected-environment acceptance.

## Rollback and remaining limits

Stop choosing dialect `agy` for new generations and close this opt-in
session/generation through Host. No default route needs reverting; uninstalling
or editing the user's existing plugin is unnecessary. Windows native steering
is unsupported. Native trace schema/protobuf layout is version-coupled and
fails closed; a missing schema sample prevents capability declaration. No
claim of model comprehension, production sandbox deployment, or end-to-end
Web/Electron/Expo UI consumption is made by this provider-only batch.
