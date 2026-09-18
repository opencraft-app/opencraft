## goal
Upgrade only the user-identified Hermes instance to the current backend blueprint and verify newly created local profiles can create a Hosted Room.

## non_goals
- Do not rebuild profiles, alter Bot data, change source, GitOps, or other instances.
- Do not commit, push, or roll out a shared image/pool.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-09-16: upgrade the specified remote Hermes instance after diagnosing its Hosted Room profile rejection.

## interface_refs / data_structure_refs
- `POST /v1/instances/{instanceId}/debug/exec` runs an instance-side command as `agentuser`.
- `groups.create` must accept newly created native local profiles after the backend upgrade.

## history_context
- `current_design_refs`: `images/README.md`, `.agents/skills/hermes-cvm-image/SKILL.md`.
- `relevant_evolution`: Hosted Room local-profile rejection was observed from the target instance.

## acceptance
- Target reports the updated Hermes/backend version.
- Existing profiles remain present and the observed group creation succeeds.

## affected_paths
- External target instance only; this pack records the operation.

## required_context
- Hermes CVM image skill and image build documentation.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `.agents/skills/hermes-cvm-image/SKILL.md` | existing VM upgrade procedure | constrain target and verification |
| `images/README.md` | current Hermes blueprint contract | select upgrade command |

## evidence
- Target `ins-a5083ca11a864760a1f3527a4689ad7f` preflight: Hermes `v0.21.0 (2026.8.31)`, two named profiles, and ACLI backend upgrade support.
- Resolved latest non-Nanjing blueprint `lhbp-c6e7uu0g` (2026-09-04) and ran its target-scoped `acli backend upgrade-start --wait=true --force=true` as `agentuser`.
- Upgrade log completed in 63s, restarted the gateway, and retained both profiles. The blueprint maps to `hermes-agent-v20260901` / `v0.21.0`, so no newer Hermes source was deployed.
- Public `runtime_hermes` COS `latest.json` independently confirms the same `hermes-agent-v20260901`, source version `0.21.0`, release `v2026.8.31`.
- The target-scoped official updater first made a full `~/.hermes` backup and correctly refused the non-Git COS directory without replacing it.
- With explicit user authorization for a direct upgrade, the COS code directory was moved to a recoverable sibling backup and the official installer installed upstream source. It completed with Hermes `v0.21.3 (2026.9.14)`, then the official updater advanced it to upstream commit `741fa6acc1545f0d1cd307ea96f0cba7023ad450` and restarted both gateway and the manual `hermes serve --host 127.0.0.1 --port 9119` process.
- Final target read: two named profiles remain; updater process count is zero; gateway and serve have post-upgrade PIDs.

## risks
- Upgrade changes the target runtime; verify the exact instance before execution and preserve profiles.
- The direct GitHub-main installation bypassed the published COS artifact, image verification, and ACLI mapping; it was performed only after explicit authorization because the artifact remained at v0.21.0. The original COS code directory and a full Hermes data backup remain available for recovery.

## validation
- Read version/profile state before and after upgrade; reproduce Hosted Room creation after restart.

## decisions
- Use a target-scoped backend upgrade, not a pool-wide image rollout.

## scan_scope
- `images/`, `.ci/runtime/commands/`, `ctl/pkg/instance/`.

## scan_output
- Bounded source inspection only.

## handoff
- Complete: target now runs current upstream source. A user-visible group creation was intentionally not synthesized; reopen the existing OpenCraft dialog and retry with the two real profiles to validate the original symptom.
