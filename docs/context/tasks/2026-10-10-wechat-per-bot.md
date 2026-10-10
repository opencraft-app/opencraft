## goal
Allow separate Bots on one LightVela instance to connect separate Weixin accounts, with one Weixin connection per Bot/Profile.

## non_goals
- Sharing one Weixin credential across Bots or changing WhatsApp ownership.
- Production rollout, GitOps changes, and cross-instance account deduplication.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this task, 2026-10-10: change the current instance-wide Weixin limit to Bot-scoped connections.
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`: the earlier instance-wide rule is superseded for Weixin by this request.

## interface_refs / data_structure_refs
- `GET /v1/instances/:instanceId/bots` and `weixin_owner` on each Bot.
- CTL channel claim/release/confirm and Weixin login session APIs.
- `$HERMES_HOME/.lightvela/channel-bindings/weixin.json` legacy binding and Profile-local Hermes channel configuration.
- Preserve WhatsApp instance-wide ownership and serialize concurrent QR sessions per instance.

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`, `ctl/pkg/instance/bots.go`, `ctl/pkg/instance/weixin_login.go`.
- relevant_evolution: the 2026-09-09 multi-Bot PRD intentionally limited Weixin to one connected Bot per instance.
- superseded_refs: the Weixin-only instance-wide clause in that PRD.

## acceptance
- Two Bots under one instance can connect different Weixin accounts sequentially and remain independently connected.
- A Bot cannot overwrite or disconnect another Bot's Weixin connection; its own state is shown in the UI.
- Legacy connections remain assigned to their prior owner; failed/cancelled scans do not clear confirmed connections.
- CTL focused tests and frontend check/test gates pass, with limitations stated if live Weixin login is unavailable.

## affected_paths
- `ctl/pkg/instance/`, `ctl/pkg/model/channelloginsession/`, `ctl/migrations/`, `frontend/src/`, `docs/engineering/domains/agent-gateway-runtime.md`.

## required_context
- `service-ctl`, `service-frontend`, `agent-gateway-runtime`, `identity-access`, `site-environment-routing`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/ctl.md` | CTL ownership | Set API and test boundary |
| `docs/context/project/services/frontend.md` | Frontend ownership | Set UI verification boundary |
| `docs/context/domains/agent-gateway-runtime.md` | Channel routing | Require Profile scope |
| `docs/context/domains/identity-access.md` | Login session access | Retain user/instance authorization |
| `docs/context/domains/site-environment-routing.md` | Dual-site surface | Avoid treating local success as production |
| `ctl/AGENTS.md` | CTL service rules | Run service tests |
| `frontend/AGENTS.md` | Frontend service rules | Run check/test/build and sync guard |
| `frontend/DESIGN.md` | UI interaction rules | Preserve the existing channel cards and remove only obsolete occupancy UI |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | UI neighbor | Check tests and generated locale path |

## evidence
- Initial exact searches found `weixin_owner`, CTL `ClaimInstanceBotChannel`, and the single active QR session query.

## risks
- Existing instance-wide binding data must migrate without changing its owner.
- Scan cancellation after CTL restart must identify the target Profile from durable session data.
- Real Weixin account and Hermes gateway routing require authenticated integration validation before release.

## validation
- Focused CTL tests for two Bot bindings, migration, login sessions, and ownership.
- `frontend` check, relevant tests, build; OpenCraft sync guard if the frontend source changes.
- Context change-impact validation.

## decisions
- Keep QR sessions serialized per instance; this does not prevent two persisted connections.
- Preserve WhatsApp's current instance-wide behavior.

## scan_scope
- `ctl/pkg/instance`, `ctl/pkg/model/channelloginsession`, `frontend/src/pages/marketing`, `frontend/src/repositories`.

## scan_output
- Bounded `rg` results in this task's command history.

## handoff
- The user authorized separate CTL and frontend merge requests. This Task Pack travels with the CTL MR; the frontend MR has its own scoped Task Pack and depends on CTL landing first. Neither MR authorizes merge, GitOps, or production release.
- Focused CTL binding, batch listing, login-session and ownership tests passed with `CGO_ENABLED=0`; CTL package compilation and `go vet` passed. Full package tests are blocked by host CGO linking or rootless Docker / SQLite requirements.
- Frontend focused tests (88 cases), `pnpm check`, `pnpm build`, documentation sync, and OpenCraft vendored-copy guard passed. The full frontend suite exposed unrelated existing failures and later ran out of memory; the relevant focused suite passed.
- `validate_change_impact.py` passed for the changed CTL and frontend paths, matching the agent-gateway-runtime design document. `git diff --check` passed.
- Regenerating i18n dictionaries removed the obsolete message but would require an OpenCraft vendored-copy update. The repository requires the frontend source to be committed before that sync; without commit authorization, generated dictionaries were restored. The obsolete message is no longer referenced by the UI.

## checkpoint
### stage
Implementation and local review complete; prepare the separate CTL MR.

### verified
- Weixin bindings are keyed by Hermes Profile, and legacy single bindings retain their original owner.
- Different Bots on one instance can hold separate Weixin bindings; release and delete target only the selected Bot/Profile.
- WhatsApp remains instance scoped, and QR login sessions remain serialized per instance.
- Local checks listed in `handoff` passed at the end of this task.

### unverified
- Authenticated two-account Weixin login through a deployed public gateway and Hermes runtime.
- Full frontend and CTL suites on a correctly provisioned CI host.

### discard
- An earlier read-only change-impact invocation against `origin/master...HEAD` saw no uncommitted files; the explicit changed-file invocation supersedes it.
- An interim i18n regeneration was restored because it could not pass the OpenCraft sync workflow before commit.

### restore
- CTL worktree: `/Users/pablozhong/.codex/worktrees/wechat-per-bot-ctl/lightvela`.
- Frontend worktree: `/Users/pablozhong/.codex/worktrees/wechat-per-bot/lightvela`.

### next_action
- Validate the split CTL branch, then commit, push, create and verify its MR.
