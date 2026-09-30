---
id: 2026-09-30-streaming-first-response-observability
type: task
scope: Passive VelaGW and NewAPI timing diagnostics for slow or canceled streaming requests.
triggers: ["VelaGW", "NewAPI", "first response", "streaming"]
owner: wisp/mono2-maintainers
authority: derived
source_of_truth:
  - docs/engineering/journeys/agent-request-streaming.md
status: active
reviewed_at: 2026-09-30
review_due: 2026-10-30
revision: 1.0.0
precedence: task
derived: true
---

## goal
Deliver low-risk, cross-service timing diagnostics for VelaGW → NewAPI streaming requests across all production Sets, with staged rollout and live verification.

## non_goals
- No change to ping, timeout, routing, retries, response status, or request/response payload handling.
- No unrelated NewAPI performance-exporter files, request-processing changes, or direct Deployment image patches.

## requirement_ids / requirement_refs / requirement_excerpt
- Conversation request, 2026-09-30: add the discussed observability to both VelaGW and NewAPI for all Sets, observe and change cautiously; the user then explicitly authorized publication.

## interface_refs / data_structure_refs
- `velagw/internal/gateway/model.go:AccessLog` and `traffic_reverse_proxy.go` own gateway timing and response classification.
- `new-api/relay/channel/api_request.go:doRequest` owns NewAPI's wait for provider response headers; `relay/helper/stream_scanner.go` observes stream completion and first event.
- Preserve proxy streaming semantics and never log prompt, credentials, or arbitrary upstream error text.

## history_context
- current_design_refs: `docs/context/domains/agent-gateway-runtime.md`; `docs/context/project/upstream-subtrees.md`.
- relevant_evolution: VelaGW already records upstream round-trip, response-header, and first-body-byte milestones; its `streaming` field describes upstream response content type, not request `stream`.
- superseded_refs: none.

## acceptance
- Slow/canceled requests have one bounded, safe correlation identifier and timing milestones on both sides.
- NewAPI distinguishes a delayed provider response header from a post-header stall before the first valid SSE event.
- Successful fast requests do not create high-cardinality or high-volume diagnostic logs.
- Tests cover streaming/nonstreaming classification and a pre-header cancellation.

## affected_paths
- `velagw/internal/gateway/` and tests.
- `new-api/relay/` and tests.
- This Task Pack; formal service design documentation if change-impact mapping requires it.

## required_context
- `agent-gateway-runtime`, `upstream-subtrees`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | P0/release boundaries | Keep deployment separate from source changes. |
| `velagw/AGENTS.md` | Service rules | Focused route tests. |
| `new-api/AGENTS.md` | Subtree rules | Keep local changes separate from upstream sync. |
| `docs/context/domains/agent-gateway-runtime.md` | Runtime ownership | Avoid altering route/stream behavior. |
| `docs/context/project/upstream-subtrees.md` | Subtree ownership | Preserve upstream lineage. |
| `docs/engineering/journeys/agent-request-streaming.md` | Formal design | Record cross-service diagnostic semantics and limits. |
| `new-api/MONO2_SUBTREE.md` | Release boundary | Build does not imply deploy. |
| `velagw/MONO2_SUBTREE.md` | Release boundary | Source import does not imply deploy. |
| `docs/context/project/adjacency/argocd-ci-secrets.md` | Release neighbor | Verify image/GitOps independently. |
| `docs/context/domains/release-gitops.md` | Release boundary | Require live GitOps revision, image digest, Synced and Healthy evidence. |
| `argocd/README.md` and `.ci/AGENTS.md` | Release ownership | Separate source, image, GitOps, and leaf sync. |
| `velagw/docs/set-blue-green-upgrade.md` and `velagw/docs/release-rings.md` | Set rollout contract | Use the managed blue-green Release Ring/Campaign path, not direct Deployment patches. |

## evidence
- Shanghai VelaGW access samples: 73 pre-header 502s in a 5-minute window, 20 in 58–62 s; all had `upstream_status=0` and `request_context_error=context_canceled`.
- NewAPI ping defaults disabled at 60 s; do not change it in this task.
- Source now records a generated 16-character VelaGW ID in access logs and forwards it only to NewAPI; caller-supplied IDs are overwritten. NewAPI records provider header wait and completed stream timing only when slow/failed.
- Before rollout, `velagw-shprod` and `velagw-sgprod` Argo apps are `Synced/Healthy` at GitOps revision `d4a49712d`; VelaGW workload images match their GitOps pins. Existing NewAPI deployments use per-Set digest pins, not the environment default pin: five managed Shanghai Sets and two managed Johor Bahru Sets.

## risks
- Logging secrets/PII: use only generated correlation IDs, booleans, enums, and elapsed milliseconds; prevent diagnostic header wildcard passthrough to providers.
- Log volume: emit diagnostics only for correlated VelaGW requests that are slow/canceled/error.
- Added work in proxy hot path: keep it constant-memory and avoid body buffering.
- Rollout disruption: source and production release are separate gates; verify health and rollback pin if later authorized.
- NewAPI traffic generation images are immutable; use the existing blue-green Set upgrade API and Release Ring/Campaign, with one canary and soak before full rollout. Preserve current per-Set digests as rollback evidence.

## validation
- Full Go package tests for `velagw/internal/gateway` and NewAPI `relay/channel`, `relay/common`, `relay/helper`.
- Service lint/type/test commands and context change-impact validation.
- 2026-09-30: `go test ./internal/gateway -count=1` passed in the existing Go 1.25.14 builder image.
- 2026-09-30: `go test ./relay/channel ./relay/common ./relay/helper -count=1` passed in the same builder image.
- `go vet ./internal/gateway` in VelaGW and `go vet ./relay/channel ./relay/common ./relay/helper` in NewAPI passed in the same builder image.
- `gofmt`, `git diff --check`, and `validate_change_impact.py` with explicit changed paths passed; the mapping requests Owner review at MR time. The `--staged` check remains a handoff gate if these files are staged later.
- Repository-wide `validate_context.py` remains red on pre-existing unrelated task-document schema/secret/catalog findings; no finding names this Task Pack after adding its required metadata.

## decisions
- Both components, all Sets; diagnostics only. Do not enable NewAPI ping as part of this patch.
- Skip uncorrelated direct-NewAPI traffic to bound added log volume; do not log payload, credentials, raw errors, or arbitrary caller-provided trace strings.

## scan_scope
- `velagw/internal/gateway/traffic*`, `new-api/relay/channel/api_request.go`, `new-api/relay/helper/stream_scanner.go`, adjacent tests.

## scan_output
- Bounded `rg` results in the active conversation; no bulk scan artifact.

## handoff
- Source implementation and focused tests passed. Production publication is now authorized but not yet performed. Next: isolate and commit the exact source files on current `master`, build immutable images, then use the production GitOps and blue-green Set upgrade paths. Compare same-ID gateway/NewAPI timelines and watch error rate, log volume, and latency before considering any timeout or ping change.
