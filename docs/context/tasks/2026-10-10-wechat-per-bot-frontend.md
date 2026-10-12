---
id: task-wechat-per-bot-frontend-20261010
type: task
scope: Deliver the per-Bot Weixin frontend and repair MR !5180 target drift.
triggers: []
owner: pablozhong
authority: derived
source_of_truth:
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md
status: retired
reviewed_at: 2026-10-12
review_due: 2026-11-30
revision: 1.1.0
precedence: task
derived: true
---

## goal
Show Weixin as an independent connection for each Bot and update dual-site guidance after the CTL binding change.

## non_goals
- Change CTL, Hermes, WhatsApp ownership, GitOps, or production state in this MR.

## requirement_ids / requirement_refs / requirement_excerpt
- User request on 2026-10-10: separate CTL and frontend MRs for one Weixin account per Bot, with different Bots able to connect different accounts in one instance.
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`: replace the old instance-wide Weixin rule.

## interface_refs / data_structure_refs
- `GET /v1/instances/:instanceId/bots` returns `weixin_owner` for the owning Bot only once the CTL MR is deployed.
- `AgentSettingsPage` passes `weixinChannel` to the existing channel panel. WhatsApp ownership remains instance-wide.

## history_context
- current_design_refs: `frontend/src/pages/marketing/agent-settings-page.tsx`, `frontend/src/repositories/http-repositories.ts`, and the multi-Bot PRD.
- relevant_evolution: the old UI disabled Weixin whenever another Bot owned it.
- superseded_refs: the old Weixin occupancy banner and documentation screenshot.

## acceptance
- Every Bot can open its Weixin connection entry, and no instance-wide Weixin occupancy banner appears.
- The Bot list maps two distinct Weixin owners to their respective Bots.
- WhatsApp occupancy behavior remains unchanged.
- Domestic and global Bot-switching docs describe distinct accounts per Bot.

## affected_paths
- `frontend/src/pages/marketing/`, `frontend/src/repositories/__tests__/`, `frontend/src/content/docs/`, `wiki/prd-docs/`.

## required_context
- `service-frontend`, `site-environment-routing`, `agent-gateway-runtime`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/frontend.md` | Frontend ownership | Choose checks and sync guard |
| `docs/context/domains/site-environment-routing.md` | Dual-site surface | Update both doc regions |
| `docs/context/domains/agent-gateway-runtime.md` | Channel ownership | Keep Bot/Profile scope |
| `frontend/AGENTS.md` | Service gate | Run check, tests, build, OpenCraft guard |
| `frontend/DESIGN.md` | UI interaction | Preserve the existing card layout |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | Neighbor | Validate locale and docs generation |
| `docs/context/flows/tapd-gongfeng-delivery.md` | Existing MR conflict repair | Update the original source branch and verify remote state |
| `docs/context/tasks/TASK-TEMPLATE.md` and `CHECKPOINT-TEMPLATE.md` | Task state contract | Record this conflict repair and its validation |

## evidence
- Exact search located the Weixin occupancy banner and `weixinChannel` gate in `agent-settings-page.tsx`; the repository mapping already reads `weixin_owner` per Bot.

## risks
- This MR depends on the CTL MR. If the frontend lands first, the old CTL can still reject a second Bot's claim.
- Generated locale dictionaries and OpenCraft copies require the source-first commit sequence in `frontend/AGENTS.md`.

## validation
- Focused tests: `agent-channel-context-notice.test.tsx`, `http-repositories.test.ts`.
- `pnpm check`, `pnpm build`, docs sync, and `npm --prefix opencraft run check:mono2-agent-console`.
- Full frontend suite has existing unrelated failures and a local Vitest memory failure; record the exact CI result in the MR.

## decisions
- Retain the existing channel panel and WhatsApp notice. Remove only the Weixin occupancy gate and banner.
- Do not use the obsolete Weixin screenshot in docs.

## scan_scope
- `frontend/src/pages/marketing`, `frontend/src/repositories`, `frontend/src/content/docs`.

## scan_output
- Bounded searches in this task found the UI gate, repository mapping and translated Bot-switching pages.

## handoff
- Submit this MR separately from CTL, targeting `master`; mark CTL MR as prerequisite. Neither MR is a production release.

## cr_followup_2026_10_11
- !5180 was merged locally with current `origin/master`; the only content conflict was generated `UPSTREAM.json`, rebuilt with `sync:mono2-agent-console` after the merge commit.
- `pnpm check`, `pnpm build`, 88 focused Vitest cases and `check:mono2-agent-console` pass after the merge. Vitest used `--api.host 127.0.0.1` because this host cannot resolve `localhost`.
- Frontend rollout remains dependent on CTL migration and deployment. Real two-account and duplicate-account Weixin scans remain unverified.

## checkpoint
### stage
MR !5180 conflict repair is complete locally against `origin/master` at `a527d0c13` on 2026-10-12; ready to push the original branch and inspect remote CI.

### verified
- The only content conflict was generated `UPSTREAM.json`; source and locale changes merged automatically.
- Current 88 focused tests, `pnpm check`, `pnpm build`, documentation validation and staged change-impact checks pass against `a527d0c13`.
- Source merge commit is `faa2e194f`; the official sync/check scripts regenerated and verified 136 OpenCraft Agent Console files.
- Relative to current `origin/master`, the MR still changes the intended Weixin UI, tests, guidance, and generated locale closure.
- Repository-wide Context catalog and contract tests still fail on pre-existing historical Task Pack metadata; the same missing metadata is present in target-branch documents. This task's front matter was repaired.

### unverified
- Live two-account Weixin login through the public gateway.
- CI and remote mergeability after the final push.

### discard
- Build-only `frontend/next-env.d.ts` and font subset changes were restored.

### restore
- Worktree: `/Users/pablozhong/.codex/worktrees/wechat-per-bot/lightvela`.

### next_action
- Commit the regenerated manifest, push the existing MR branch, verify its remote source SHA and mergeability, then resume the Beijing-backed local preview on port 5176.
