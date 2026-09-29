---
id: 2026-09-29-velagw-proxy-error-diagnostics-checkpoint
type: task
scope: Recovery checkpoint for the active VelaGW proxy error diagnostics task.
triggers: ["checkpoint", "velagw", "upstream_roundtrip_error"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-29-velagw-proxy-error-diagnostics.md
status: active
reviewed_at: 2026-09-29
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## requirement_ids / requirement_refs / requirement_excerpt
- Conversation, 2026-09-29: distinguish Shanghai VelaGW proxy error causes, then consider publishing.

## interface_refs / data_structure_refs
- See the linked Task Pack for `AccessLog` and `trafficProxyPlan` contracts.

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md` and `docs/engineering/domains/release-gitops.md`.
- relevant_evolution: Shanghai uses manual Argo sync; the diagnostic image was promoted and synced after source and GitOps review gates.
- superseded_refs: none.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/tasks/2026-09-29-velagw-proxy-error-diagnostics.md@working-tree` | Active task state | Restore exact scope and validation |

## stage
Shanghai VelaGW diagnostic release completed; post-release observation has not yet captured a live 502 sample.

## verified
- Complete Docker image build passed full VelaGW Go tests, binary compilation, 50 Web tests, and TypeScript/Web build; `go vet ./...` passed.
- Release bundle contract suite passed 102 tests; documentation validation passed.
- Staged change-impact validation passed and requires owner review.
- Shanghai Argo application was `Synced/Healthy` on the old image digest; traffic Deployment was 2/2.
- User authorized Shanghai production release; the source MR was pushed from an isolated latest-master branch, and Gongfeng returned `Review check not passed` (409) on merge.
- Source MR !4842 was reviewed and merged as `728f32f22`; Shanghai candidate image tag `velagw-728f32f227c4` resolved to digest beginning `sha256:3431dfeedb8a`.
- GitOps MR !4844 changed only the Shanghai image pin and deployment timestamp, then merged as `bb25ebd74`.
- Manual Argo sync of `velagw-shprod` completed successfully at `bb25ebd74`; the Application is `Synced/Healthy`, all ten VelaGW Deployments are on the new digest with 2/2 Ready, and the PostSync bootstrap Job succeeded.
- Old traffic Pods drained and disappeared; the new traffic Pods are both Ready. The first 20 observed access logs had 19 responses with status 200 and one upstream 429; no proxy 502 sample yet.

## unverified
- Need a live proxy failure sample before claiming the new diagnostic fields identify the first disconnecting hop.
- Repository-wide context catalog has pre-existing errors; scoped baseline comparison remains if needed.

## discard
- Bare Alpine full-test attempts failed due to missing bootstrap tools and worktree Git context; the project Dockerfile build supersedes them.

## restore
- Release worktree: `/data/mono2-velagw-proxy-diagnostics-20260930`, branch `codex/velagw-proxy-diagnostics-20260930`; original dirty worktree `/data/mono2-k0s-observability-20260928` remains separate.
- Relevant implementation: `velagw/internal/gateway/{model.go,service.go,traffic_reverse_proxy.go,traffic_proxy_diagnostics.go,traffic_proxy_diagnostics_test.go}`.
- Preserve unrelated observability changes in the original dirty worktree; stage only task-scoped files.
- Task pack: `docs/context/tasks/2026-09-29-velagw-proxy-error-diagnostics.md`.

## next_action
Continue monitoring Shanghai 5xx and 429 after rollout; when an `upstream_roundtrip_error` recurs, inspect only the bounded diagnostic fields to distinguish client cancellation from ingress-body or upstream transport failure.

## 2026-09-30 timing extension
- Shanghai post-release logs showed 30/60-second `context_canceled` clusters with no upstream response status. The existing access log cannot prove when the upstream request was attempted or whether response headers/body bytes arrived.
- Added elapsed milliseconds from the first upstream RoundTrip attempt through return, final response headers, and first response-body byte. The latter is not necessarily a model token; missing fields mean the milestone was not observed.
- `go test ./...` and `go vet ./...` passed under `velagw/`. This extension remains local and has not been committed or published; production continues to run the preceding diagnostic image.
