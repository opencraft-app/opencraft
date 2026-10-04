---
id: task-newapi-model-not-found-status-2026-10-01
type: task
scope: NewAPI channel-selection error status for models absent from an authorized group.
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-01
review_due: 2026-10-31
revision: 1.0.0
precedence: task
derived: false
---

## goal

Return HTTP 404 `model_not_found` when the requested model has no configured ability in the caller's eligible group, instead of the previous HTTP 503.

## non_goals

- Do not change VelaGW routing, Hermes, NewAPI retry, or channel selection.
- Do not classify disabled or temporarily unavailable channels as unknown models.
- Do not commit, deploy, or sync the upstream subtree pin in this task.

## requirement_ids / requirement_refs / requirement_excerpt

- Conversation request, 2026-10-01: “这种情况变成404”. Context: unsupported model / group currently returns 503 from NewAPI and may be mistaken for platform unavailability.

## interface_refs / data_structure_refs

- `new-api/middleware/distributor.go`: OpenAI-compatible `{error:{message,type,code}}` response after channel selection.
- `new-api/model/ability.go`: `abilities` records model/group configuration, including `enabled=false` when a channel is disabled.
- Invariant: `auto` checks only user-eligible groups; database lookup errors fail closed to 503, not 404.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`; `new-api/MONO2_SUBTREE.md`.
- `relevant_evolution`: local NewAPI previously returned `503` and `model_not_found` for both absent and unavailable models.
- `superseded_refs`: none.

## acceptance

- Unknown model/group returns 404 with `model_not_found`; configured but disabled channel returns 503 with `get_channel_failed`.
- Existing successful channel selection is unchanged; relevant NewAPI Go tests pass.

## affected_paths

- `new-api/model/ability.go`, `new-api/middleware/distributor.go`, NewAPI locales and tests.
- `docs/engineering/domains/agent-gateway-runtime.md`.

## required_context

- Pack `agent-gateway-runtime`, NewAPI service context, root and NewAPI `AGENTS.md`.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@current` | Repo permissions and task requirements | No production or GitOps change; Task Pack and validation |
| `new-api/AGENTS.md@current` | Subtree boundary | Keep local fix separate from upstream sync |
| `new-api/MONO2_SUBTREE.md@current` | Upstream pin and release contract | Do not sync or deploy implicitly |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | Gateway ownership | Place status classification in NewAPI, not VelaGW |
| `docs/context/project/services/new-api.md@2.1.0` | Service boundary | Do not move subtree pin |
| `docs/context/tasks/TASK-TEMPLATE.md@2.1.0` | Task state contract | Structure this pack |
| `docs/context/project/adjacency/cloudladdergateway.md@1.0.0` | Closest gateway adjacency card; not directly applicable | Confirm NewAPI implementation and tests are the relevant neighbors |

## evidence

- `new-api/middleware/distributor.go` previously returned 503 for both selection errors and nil channel.
- `new-api/model/ability.go` retains disabled abilities, allowing absent-vs-unavailable classification.
- `go test ./model ./middleware` and `go vet ./model ./middleware` passed in the Go 1.26.1 Alpine container; tests cover unknown model, disabled channel, and configuration-lookup failure.
- `validate_documentation.py --repo . --format json` returned no errors or warnings; explicit change-impact validation matched `agent-gateway-runtime` and passed.

## risks

- A stale or missing ability record could misclassify a configured model as 404; mitigate with DB-authoritative lookup only on no-channel path, and preserve 503 on lookup errors.
- Hermes may treat 404 as terminal for the requested model; retain `model_not_found` code so configured fallback can switch models rather than retrying the same unavailable route.

## validation

- Format changed Go files; run focused `go test ./model ./middleware` and relevant context checks.
- Review diff to ensure no unrelated dirty worktree files are overwritten.

## decisions

- Use persisted abilities (including disabled), not enabled-channel cache, to classify unknown models. Owner: current task.
- Keep 503 for selection errors and configured-but-unavailable models; use `get_channel_failed` code rather than `model_not_found` for those. Owner: current task.

## scan_scope

- Bounded searches under `new-api/model`, `new-api/middleware`, `new-api/i18n`, and mapped design documentation.

## scan_output

- Source locations summarized in evidence; no separate scan artifact.

## handoff

- Local code change and tests only. No commit or deployment authorized; owner review required before merging the mapped design change.

## stage

- Implementation and local validation complete; next gate is owner review and explicit commit/release authorization.

## verified

- Focused Go tests and vet pass. Documentation validation and change-impact check pass.
- Existing unrelated worktree changes were not reverted or committed.

## unverified

- No production request or Hermes end-to-end test has run against a deployed NewAPI build.

## discard

- Earlier unsplit interpretation that every no-channel error was `model_not_found`; configured-but-unavailable routes remain 503.

## restore

- Work from `new-api/middleware/distributor.go`, `new-api/model/ability.go`, and the two new focused tests. Preserve the already-dirty worktree.

## next_action

- Review the local diff; request explicit authorization before any commit, image build/push, or GitOps deployment.
