## goal
Restore canonical Turn/Item order after AppServer history hydration and reconnect without losing later live notifications.

## non_goals
- Change Codex AppServer, DSH wire protocol, UI sorting, deployment, or unrelated dirty worktree edits.

## requirement_ids / requirement_refs / requirement_excerpt
- User report (2026-09-26): mobile reconnect displayed the final answer above older commentary and edit activity; approved an implementation that respects ordered AppServer history.

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-session/src/merge-turns.ts`: stable-ID stream merge versus ordered history reconciliation.
- `opencraft/packages/appserver-session/src/resume-coordinator.ts`: Resume history commit, older-page load, notification replay.
- `opencraft/packages/appserver-protocol/src/resume-history.ts`: `itemsView`, ordered pages and opaque cursors.
- Invariant: history owns order within its covered window; buffered notifications remain later than that snapshot.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: existing completion snapshots already replace full Item membership; Resume history currently uses additive stable-ID merge.
- `superseded_refs`: none.

## acceptance
- Final-first reconnect reproducer becomes chronological; full and partial histories, live replay, duplicate IDs and stale status are covered by focused tests.
- Focused AppServer tests, package typecheck and relevant boundary checks pass.

## affected_paths
- `opencraft/packages/appserver-session/src/`, `opencraft/tests/appserver-session.test.ts`, related formal design documentation.

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`, `identity-access` (router result).

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Repository and service boundaries | Scope and validation |
| `docs/context/domains/agent-gateway-runtime.md`, `docs/context/domains/site-environment-routing.md`, `docs/context/project/upstream-subtrees.md`, `docs/context/project/services/opencraft.md`, `docs/context/domains/identity-access.md` | Router must-read files | Ownership and non-goals |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance procedure | Test and delivery evidence |
| `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md` | Architecture | Session/Replica ownership |

## evidence
- Backend rollout order is chronological; current `mergeTurns` can reproduce final-before-progress with a cached final and later full history.
- `appserver-session` tests cover same-View disconnect/reconnect, paginated Item hydration, ordered partial windows, stale in-progress pages, full membership replacement and buffered post-snapshot notifications.
- Direct Node runs: `test:appserver` file set 232/232 passed; Chat/Lab/session file set 479/479 passed; `chat-core`/DSH/session focused set 138/138 passed; appserver-session, workbench-runtime, Web and Expo typechecks passed; platform-boundary check passed.
- Changed-file documentation impact check passed with `agent-gateway-runtime` mapped design update; owner review remains advisory.
- Repository documentation validator passed with zero broken first-party links and no warnings; `git diff --check` passed.

## risks
- Partial history lacks a per-Item sequence; only claim authoritative order within the fetched window, and preserve out-of-window Items around shared anchors.
- Existing dirty files belong to other work; preserve them.

## validation
- Direct Node equivalents of the AppServer test set, Chat/Lab/session tests, relevant package/runtime/Web/Expo typechecks and platform boundary check passed. The full `npm run gate` could not be launched because this machine has no `npm` executable; an actual browser/mobile resume smoke remains pending.

## decisions
- Separate ordered history reconciliation from additive live-notification merging; use existing Resume notification buffer.

## scan_scope
- `opencraft/packages/appserver-session`, `opencraft/tests/appserver-session.test.ts`, relevant reference implementations.

## scan_output
- Bounded source searches only.

## handoff
- Source and tests updated. No running Web/Host process was replaced; live mobile reconnection remains unverified.
