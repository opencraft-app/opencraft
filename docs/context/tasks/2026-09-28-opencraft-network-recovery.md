# OpenCraft weak-network recovery ownership

## goal
Restore usable Host, Thread and catalog projections automatically after transient Web disconnection.

## non_goals
- No preview replacement, engine restart, mutation replay, Git commit or deployment.
- Preserve unrelated dirty worktree changes, including Codex fork and queue work.

## requirement_ids / requirement_refs / requirement_excerpt
- Conversation 2026-09-28: user approved recovery ownership refactor (“搞起来”).

## interface_refs / data_structure_refs
- `opencraft/packages/app-host-protocol/src/index.ts`: optional connection probe capability; lease and physical generation remain distinct.
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`: Host readiness must not await resource recovery.
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`: Host-scoped query recovery.

## history_context
- current_design_refs: `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`, `opencraft/docs/execution-ownership.md`.
- relevant_evolution: existing Web renewable transport, server Ping/Pong and sidebar-only readiness invalidation.
- reference: read-only `ref/bb` commit `62fe3bc`, reconnect notification and cache revalidation model.

## acceptance
- Host readiness independent of failing or slow Thread/terminal/watch restoration.
- Failed active catalog queries recover after Host initialize; old results cannot overwrite recovered data.
- Visible/online hints probe a shared connection once; stale probes cannot close a successor.
- Host claim/handshake waits terminate; expired claims are released on late acknowledgement.
- No automatic replay of user mutations or shutdown of Host-owned turns.

## affected_paths
- OpenCraft app-host protocol/client/server, Web transport/runtime queries, workbench runtime, focused tests and architecture docs.

## required_context / context_receipt
- Root and OpenCraft `AGENTS.md`: scope, ownership, verification.
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` and `references/verification.md`: lifecycle and late-result tests.
- Above architecture docs: independent execution and client attachment.
- Context router returned no pack; bounded exact searches located reconnect and catalog paths. No relevant adjacency card exists for OpenCraft.

## decisions
- Keep stable query resource keys; cancel/invalidate on logical connection readiness.
- Probe is optional and negotiated, bypasses the business request queue, and only proves bridge reachability.

## validation
- Focused transport, Host, runtime, query tests; affected workspace typechecks and boundaries; Web build.
- Synthetic weak-network/late-result tests do not claim phone lock-screen acceptance.

## stage
Implementation and automated regression verification complete; live preview unchanged.

## verified
- Current service unchanged; repository has unrelated dirty changes.
- Six affected workspaces passed typechecks; boundaries and Web build passed.
- Focused Host/client tests: 24/24 passed, including late lease grant cleanup,
  local acknowledgement cancellation, and stale initialization rejection.
- Session/terminal/runtime/query/WebSocket recovery batch: 58/58 passed, including
  independent Thread restoration, mounted failed-query recovery, foreground probe
  coalescing and stale-probe isolation.
- Real loopback headless HTTP/WebSocket suite: 11/11 passed using `node --import tsx`,
  including negotiated probe without engine activation and disconnect handling.
- Earlier new resource fixture omitted required `approvalsReviewer`; corrected the
  fixture contract and verified the recovery test passes.
- `git diff --check` passed. Architecture/domain ownership docs updated.

## unverified
- Physical phone weak-network and lock/unlock acceptance remains pending.
- Built repository artifacts have not replaced the running preview.

## restore / next_action
- Hand off source and automated evidence; replace preview only upon user request,
  then verify mobile foreground recovery and no admitted-turn replay.
