## goal

Make OpenCraft turn interruptions attributable at the client RPC boundary and add regression coverage proving browser ambient-state changes do not independently interrupt an active turn.

## non_goals

- Do not change the upstream AppServer `turn/interrupt` wire contract.
- Do not record prompts, browser contents, credentials, or other payload data.
- Do not commit, push, publish, or deploy.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-24: investigate the unexpected interruption timeline deeply and proceed with diagnostic logging.
- Observed rollout evidence: an explicit `Op::Interrupt` submission preceded `turn_aborted`; browser metadata was paired with human input and was not independently submitted.

## interface_refs / data_structure_refs

- `opencraft/packages/chat-runtime/src/ports.ts`: internal interruption provenance contract.
- `opencraft/packages/composer-appserver/src/command-port.ts`: final client RPC boundary.
- `opencraft/packages/codex-composer/src/codex-composer.tsx`: Stop control event source.
- `opencraft/apps/workbench-web/src/browser/browser-ambient-context.ts`: immutable submit-only browser metadata.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md` and current runtime/composer source.
- `relevant_evolution`: browser ambient metadata is attached only while creating a submit intent; interruption currently carries no source metadata.
- `superseded_refs`: none.

## acceptance

- A Composer Stop interruption carries source, trigger kind, trusted-event flag, and timestamp to the AppServer command boundary.
- Side-chat Stop is distinguishable from main-composer Stop; unattributed callers remain explicitly unknown.
- The emitted diagnostic contains only identifiers and provenance, never user/browser payloads.
- Focused command-port, runtime, and browser ambient-context tests pass with typecheck/boundary checks.

## affected_paths

- `opencraft/packages/chat-runtime/`
- `opencraft/packages/composer-appserver/`
- `opencraft/packages/codex-composer/`
- `opencraft/apps/workbench-web/`
- `opencraft/tests/`
- This task pack.

## required_context

- Root and OpenCraft `AGENTS.md` files.
- OpenCraft maintenance skill verification guidance.

## context_receipt

| file | reason | use |
|---|---|---|
| `AGENTS.md@385f691ba` | repository boundaries and Task Pack contract | scope and no-publish boundary |
| `opencraft/AGENTS.md@385f691ba` | OpenCraft architecture and validation | select focused checks |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@385f691ba` | maintenance workflow | implementation and validation sequence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@385f691ba` | verification matrix | focused tests and boundary check |

## evidence

- Follow-up 2026-09-25: the daemon Codex adapter now logs an allowlisted `appserver-start`, `appserver-exit`, `client-disconnect`, or `turn-interrupt` event with UTC time, process ID and relevant client/thread/turn/request IDs. It does not log RPC params or prompt text.
- Focused adapter tests: 2 passed; daemon TypeScript check and platform boundary check passed. This is source-only; the running preview has not been rebuilt or restarted.
- Context route `opencraft turn interrupt provenance browser ambient context` matched no pack; bounded exact source search was used.
- Existing rollout logs identify an explicit Interrupt submission but contain no client/source/trusted-event provenance.
- Focused tests: 51 passed, 0 failed across command port, conversation runtime, and browser ambient context.
- Typecheck passed for `chat-runtime`, `composer-appserver`, `codex-composer`, `workbench-runtime`, and `workbench-web`.
- `npm run check:boundaries` passed.
- A normal `npm ci` reached the unrelated `node-pty` native build but the container rejected header extraction ownership changes; `npm ci --ignore-scripts` installed the TypeScript test toolchain successfully.
- Reconnect/Resume source audit found no main-thread interrupt call. Temporary Side Chat close is the only cleanup path that intentionally interrupts, and is now attributed as `side-chat-close`.
- The baseline-gating adapter now preserves provenance instead of dropping it before the AppServer command boundary.

## risks

- Interface fan-out can break test doubles; keep provenance optional and validate workspace typechecks.
- Diagnostics could leak content; use a fixed allowlist of IDs and scalar provenance only.

## validation

- Focused Node tests for command port, runtime, and browser ambient context.
- Relevant workspace typechecks and `npm run check:boundaries`.

## decisions

- Keep provenance internal and do not extend the upstream RPC params.
- Log at the command boundary immediately before `turn/interrupt`, which proves a request was actually emitted.

## scan_scope

- Exact references to `interrupt`, `turn/interrupt`, `onCancel`, and browser ambient-context injection under OpenCraft source/tests.

## scan_output

- Bounded `rg` results identified main Composer, Side Chat, runtime lease, and command-port call sites.

## handoff

- Implemented and validated locally. No commit, push, publish, or deployment performed.
