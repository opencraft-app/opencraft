# P7b project automations

Server owns project automation definitions, scheduling and human grants. The
existing orchestration Worker borrows the migrated Server WAL database and owns
claims, receipts, run transitions and cron input admission. Host owns script
custody and uses its selected sandbox pool. Once creates a Broker child, cron
queues a prompt on the selected existing thread, and script executes an explicit
argv in the selected Host sandbox authority.

## Operation and authorization

The execution-bound launcher supports `automation list/show/create/update/pause/
resume/delete/run/runs`. Each command accepts `--help` and `--json`. List and runs
have cursor/limit pagination. Mutations require an explicit idempotency key. Run
also requires occurrence ID and the complete `automationId:revision:occurrenceId`
key. Changed input under an existing key conflicts. Updates require the current
revision. Results are bounded, and oversized run output is explicitly truncated
in the catalog response.

Human authorization is separate from the execution launcher. The authenticated,
same-origin collaboration HTTP surface exposes `automation-grants` with create
and revoke, and `automations` with the same automation commands. A grant records
an exact target, project, Actor generation and permission snapshot. It stores no
login token or execution bearer. CLI create references this grant. Every trigger
rechecks Actor admission, project membership, resource access and the effective
permission snapshot before issuing a bounded execution delegation. Derived
execution can read automation catalogs but cannot mutate automations or delegate
additional thread work.

The human `automation-reconcile` endpoint inspects native evidence for an owned
unknown run. Background reconciliation also inspects unknown runs. Neither path
replays an execution. The HTTP body uses `command`, `arguments` and
`idempotencyKey`, as on the existing CLI surface. Reconciliation reads provider
proof and may settle a previously unknown outcome.

A minute cron expression supports numeric lists, ranges and steps with an IANA
zone. Missing wall times have no matching instant. Repeated wall minutes select
the earliest UTC instant. Only the current minute is eligible. Once has a
60-second admission window. Restart does not replay an admitted/running mutation,
and unknown retains its result binding for native inspection. Each automation
has one active execution across revisions. Overlap records skipped. Three
consecutive definite failures pause the definition.

Host private configuration optionally declares `automation` with `hostId` and
`environment`. The permission profile is `sandbox-policy:<selected-policy-id>`.
Private `/script/capabilities`, `/script/run` and `/script/show` routes share the
existing authenticated gateway. Scripts have durable idempotent custody and
bounded stdout/stderr, exit status and a truncation indicator. Failed cleanup
keeps the outcome unknown. Script grant creation additionally requires the
installation's explicit existing Actor management grant.

## Decisions introduced in this batch

- Human grants authorize exact target and permission snapshots. Updating a plan
  changes its schedule. Changing target or permissions requires a new grant and
  definition. This avoids widening the original authorization.
- Script permission identity is the configured sandbox policy ID. The deployment
  owner must change that ID when changing the underlying security policy.
- Derived executions have no automation mutation or further thread mutation
  capability. This batch exposes no administrative recursive-creation exception.
- Existing legacy schedules are checked before cron grant creation and every
  trigger. Active or paused legacy schedules reject the new trigger. Import is
  unavailable in this batch. No old schedule table or legacy migration changes.
  Cross-owner atomic import remains unimplemented.
- Dispatch delegation expires after one hour. Inspection uses a freshly checked
  grant context, allowing completed work to settle after that bound. Pending
  input renews its delegation only when expiry is within fifteen minutes, after
  checking the current grant. Restart restores the durable delegation projection
  before starting the input pump. Only live runs enter that indexed projection.
- Run catalogs cap page bytes and truncate large inline output. This batch does
  not introduce an artifact store or a separate output command.

## Deterministic evidence

`tests/agent-bridge/automations.test.ts` covers fake-clock timezone/DST, duplicate
and restart custody, failure pause, unknown fences and evidence reconciliation,
manual run identity, grant revocation/replay, derived-creation rejection,
pagination, Server migration upgrade/data preservation/checksum refusal,
execution launcher parsing for all nine commands, real Host HTTP script custody
with the test sandbox backend, and Server Worker/Broker once and cron paths.
The native boundary asserts that cron input authority is already committed.
Legacy schedule conflicts reject grant creation.

The Host migration appends version 3. The Server migration appends version 4.
The existing storage tests now select the current Drizzle snapshot and remove
all later tables when reconstructing their published v2 fixture.

## Real execution evidence

A temporary independent Host using the Linux systemd backend completed the
explicit script argv with stdout `P7b-script-OK`, empty stderr and exit code 0.
It used the existing default 4 vCPU / 8 GiB request and cleaned its temporary
sandbox and storage. Provider initialization required execution outside the
workspace restriction. The initial restricted attempt remained unknown and was
not replayed under its original run identity.

Once and cron each admitted one real prompt through a temporary Server Worker,
Broker and independent Host attached to the existing Codex Core/account pool.
The selected installed model was `gpt-5.6-luna`, low effort. The local model list
provided no price metadata and the official documentation lookup was unavailable,
so its absolute minimum price was not verified. No more expensive fallback ran.

Native read-only history confirmed both prompts and two failed Turns with HTTP
429 (`responseTooManyFailedAttempts`). Once native Thread
`01a1c83f-c79c-7270-a908-09c6aacafc0d`, Turn
`01a1c83f-d834-7fb2-9d69-73c203a3db12`. Cron native Thread
`01a1c83f-b23c-7330-b236-7c14a52dceef`, Turn
`01a1c83f-dbad-7e03-b52a-7a279996df5c`.

The temporary smoke's first snapshot adapter read the wrong checkpoint field and
prematurely reported completion. A separate read-only native history probe
corrected that result. These attempts prove admission, including a newly created
child and an existing-thread reprompt. They do not prove successful model output.
The temporary adapter bypassed the production thread-prepare RPC, so this is
component integration evidence. Full deployed headless composition remains
unverified. No installed service, client window, Hermes route or default engine
was switched.

## Independent review

Initial contact review `thr_h64emtyd7t` identified missing grant, delegation, script
and cross-owner import authorities. Implementation review `thr_ig6yznezjg` found
an input-authority admission race and P1 gaps in unknown reconciliation, legacy
schedule conflicts, script validation, delegated-input recovery and output bounds.
The first fixes move cron enqueue/link into one Worker transaction, reject missing
system-input authority, restore durable delegation projections, inspect native
proof for unknown runs, reject legacy conflicts, align script validation and
bound catalog output.

Incremental review found seven further P1 issues. The fixes bind reconciliation
proof to the automation origin and delegation/run identity, preserve the cron
binding in its enqueue transaction, inspect script targets through Host regardless
of the previous response shape, classify explicit pre-admission refusal as failed,
renew pending input from its current grant, index and restrict live projections,
check access before legacy schedule state, and reset the failure streak on resume.
Regressions cover forged same-key messages, long queued input renewal, terminal
projection exclusion, resume and a nonexistent script executable.

Manual occurrence identifiers are limited to 64 characters and complete run keys
to 128 characters, matching the existing Broker/input-ledger key boundary.


The final incremental review confirmed all reported P0/P1 findings closed and
found no new P0/P1. The reviewer independently passed the 14 automation tests,
14 Server storage tests and the access-control, storage-node and Host typechecks.
A fixed-delay fixture wait observed by review was replaced with a bounded wait
for the Worker admission state to settle.

Known operational limits remain explicit. A missing Host receipt cannot prove
that execution never happened, so ambiguous admission stays fenced. An operator
can restore native evidence for reconciliation. Projection work is restricted to
live runs, while very large simultaneous active-run populations remain a scaling
boundary. Successful once/cron model output and deployed headless composition
remain unverified.

## Final checks

- `npm run test:agent-bridge` passed ten consecutive final runs, each with 242
  passed and one existing opt-in Core probe skipped. The inherited invalid Bash
  function environment key was removed from the test invocation.
- Root `npm run typecheck`, `npm run check:boundaries` and
  `npm run check:storage` passed.
- `npm run test:sqlite-node` passed all 38 tests.
- The focused automation suite passed all 14 tests. Execution CLI, Broker and
  headless regression checks also passed on the implementation.
- The Codex bridge bundle built successfully. No installed process consumed that
  local artifact outside the temporary real-task smoke.
- Staged patch secret scanning found no leaks. Added source and documentation
  contain no machine-specific absolute paths.

Earlier attempts during parallel checks encountered existing AGY lock, gateway
reconnect and approval-cache timing failures. The final consecutive sequence ran
serially after the other gates. The new fixture's fixed-delay race was corrected
before that sequence. These earlier failures remain part of the validation record.

## 2026-11-11 live recheck

**未验**。同模型旧 Codex 路径也在工具前先 401 后 429；Core 账号凭据已过期，
账号池记录 `authorization-rejected`，后续代理返回 `No eligible Codex account`。
按修不了即停的边界，本轮未继续真实任务。证据、范围限制与自行决定见
[本机复查](VALIDATION-LIVE-RECHECK.md)及其脱敏录制。原有 fixture 与真实验收结论分别保留。
