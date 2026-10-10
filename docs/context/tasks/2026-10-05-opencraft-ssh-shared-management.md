---
id: opencraft-ssh-shared-management-20261005
type: task
scope: Default SSH management without an additional unlock key.
triggers: ["SSH default shared management"]
owner: mingyuxiao
authority: primary
source_of_truth: [docs/context/tasks/2026-10-05-opencraft-ssh-shared-management.md]
status: archived
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.0.0
precedence: task
derived: false
---

## goal
Default SSH Settings and catalog access without typing an extra management key.

## non_goals
- No removal of remote SSH password, pinned trust, encrypted storage, or session checks.
- No automatic SSH Connect, mutation replay or member ACL. Git publication and preview replacement were separately authorized after source verification.

## requirement_ids / requirement_refs / requirement_excerpt
- Conversation request: “我希望默认就不需要SSH解锁密钥”. Shared public-entry risk disclosed in commentary.

## interface_refs / data_structure_refs
- `opencraft/packages/app-host-protocol/src/index.ts`: validated access mode; legacy absence means access-key.
- `opencraft/apps/opencraft-daemon/src/ssh-management.ts`: installation policy and origin-bound session authority.
- `opencraft/plugins/builtin-agents/src/ssh-connections/controller.ts`: Application single-flight bootstrap and renewal.

## history_context
- current_design_refs: `opencraft/docs/ssh-codex-servers.md`, `opencraft/docs/platform-architecture.md`, `docs/engineering/journeys/agent-request-streaming.md`.
- relevant_evolution: isolated checkout baseline `b2a4d7ae0`; scoped SSH commit `3056e63bf` merged into master as `cd9be26fe`. Preview delivery preserves the existing desktop-control overlay without committing it.
- superseded_refs: prior mandatory access-key default; key protection remains optional.

## acceptance
- Default creates no extra key and uses server-issued cookie; refresh and revoked/expired session automatically renew.
- Shared UI has no unlock/lock controls; protected mode retains them.
- SSH trust/credentials/CAS, cross-site rejection and frame authorization unchanged.
- Renewal never connects SSH or replays commands; late bootstrap after disposal cannot publish.
- Backend, controller, type and actual desktop/touch UI tests pass.

## affected_paths
- SSH daemon, app-host-protocol, builtin SSH Settings, headless entry, SSH tests/smoke and mapped design documents.

## required_context
- Root and OpenCraft AGENTS, maintenance Skill verification and frontend runtime adjacency.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | Ownership and delivery constraints | Isolated source and actual client verification |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance workflow | Fresh own dependencies, bounded validation |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Config/test neighbor | Headless configuration and UI smoke |
| SSH design docs above | Current authority | Preserve native recovery and credential boundaries |

## evidence
- Router query `OpenCraft SSH management default no unlock access key authentication` had no match; bounded exact SSH source/config/test search followed.
- Own checkout `npm ci` completed successfully with Node 26.7.0.
- Full workspace typecheck, boundaries/i18n, headless 29, controller 20 and management API 21 tests passed.
- Built desktop/touch UI passed shared and protected policies in light/dark themes; shared renewal failure displays retry, not a key challenge.
- Full gate stopped at `extension-artifacts.test.ts:38`: actual persisted projection adds `artifactRef` after failed update, expected snapshot lacks it. An isolated `node --import tsx` run passed; `tsx --test` reproduced failure. Relevant extension sources and test are unchanged in this diff. No claim of full gate success.
- Combined preview verified: SSH 75 passed / one platform skip, headless 30 and desktop 100 passed; full workspace typecheck, boundaries/i18n, official package smoke and desktop/touch packaged UI checks passed.
- Independent cutover completed at `2026-10-05T12:05:03.318Z`. After reconnection, actual port-80 owner is `opencraft-ssh-shared-desktop-20261005-preview.service`, PID `3327884`, build `20261005-ssh-shared-desktop-cd9be26fe`; runtime SHA-256 `dc1859312676a6bba83efe964176f085b8d5fd87ff851795a02fed94a0e650f8`.
- Live health, empty-body shared SSH admission, saved SSH native conversation recovery and preserved native desktop viewer/control grant-release checks passed. No inference or user-application input was performed. Existing data and key were preserved; old package retained. Rollback is implemented but was not deliberately triggered.

## risks
- Anonymous shared entry intentionally exposes use of saved SSH authority to every allowed visitor. Optional key/private entry restores extra protection.
- Existing access.key preserved; rollback source/build restores old admission policy without data migration.

## validation
- SSH suite, headless suite, typecheck, boundaries/i18n, real built Workbench shared and protected UI smoke.

## decisions
- Backend policy, not UI bypass. Shared sessions auto-bootstrap; legacy policy absence fails back to key mode.

## scan_scope
- SSH management/session/controller/config/test and mapped design neighbors only.

## scan_output
- Verification logs outside repository under `/data/opencraft-ssh-native-release-ZQr7oa/`.

## handoff
- Source committed, pushed and merged into master as `cd9be26fe`. User-authorized combined temporary preview is running and independently verified after reconnection. Desktop-control overlay remains outside the scoped Git delivery; old package retained for rollback. Full gate has the extension artifact failure recorded above.
