---
id: 2026-09-29-velagw-proxy-error-diagnostics
type: task
scope: Diagnose Shanghai VelaGW reverse-proxy errors without logging request data.
triggers: ["velagw", "upstream_roundtrip_error", "Shanghai gateway diagnostics"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - velagw/internal/gateway/traffic_proxy_diagnostics.go
  - velagw/internal/gateway/traffic_reverse_proxy.go
status: active
reviewed_at: 2026-09-29
review_due: 2026-12-28
revision: 1.0.0
precedence: task
derived: false
---

## goal
Make Shanghai VelaGW reverse-proxy failures diagnosable without exposing request bodies or credentials, then validate and release the traffic-plane change through the existing production workflow.

## non_goals
- Do not change proxy routing, retry, fallback, response status, or timeout policy.
- Do not change NewAPI or enable public diagnostics endpoints.

## requirement_ids / requirement_refs / requirement_excerpt
- Conversation, 2026-09-29: investigate Shanghai gateway 5xx and add logging that distinguishes a canceled downstream request from an upstream transport/body failure; user asked to proceed and whether VelaGW needs publishing.

## interface_refs / data_structure_refs
- `velagw/internal/gateway/traffic_reverse_proxy.go`: `httputil.ReverseProxy` transport and error handler.
- `velagw/internal/gateway/service.go`: `ProxyHTTP`, body preparation, deferred access log.
- `velagw/internal/gateway/model.go`: `AccessLog` JSON contract.
- Preserve existing `status`, `upstream_status`, `error_type`, and response semantics. Diagnostic fields must be bounded, structured, and secret-free.

## history_context
- current_design_refs: `docs/engineering/domains/agent-gateway-runtime.md`, `docs/engineering/domains/release-gitops.md`, `velagw/MONO2_SUBTREE.md`.
- relevant_evolution: Shanghai traffic uses a dedicated VelaGW Argo application with manual production sync; NewAPI 400 `unexpected EOF` coincides with VelaGW `upstream_roundtrip_error` 502 but the first disconnecting hop is not known.
- superseded_refs: none.

## acceptance
- Gateway access logs distinguish request-context cancellation, inbound body read failure, and upstream transport failure, including bounded body-byte and declared-length diagnostics.
- Tests cover canceled downstream, truncated body, and secret-free error output; Go package tests and release contract gates pass.
- Release, if performed, is verified against the intended image digest, Argo revision, and traffic Deployment health.

## affected_paths
- `velagw/internal/gateway/`
- `docs/engineering/domains/agent-gateway-runtime.md`
- This task pack and checkpoint.

## required_context
- `agent-gateway-runtime`, `upstream-subtrees`, `release-gitops`, and VelaGW service context.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | Repository production and validation boundaries | Scope and release gates |
| `velagw/AGENTS.md@working-tree` | Subtree/service constraints | Service test and upstream boundary |
| `docs/context/domains/agent-gateway-runtime.md@2.1.0` | Gateway runtime ownership | Keep provider behavior unchanged |
| `docs/context/project/upstream-subtrees.md@2.2.0` | Upstream identity | Avoid treating subtree source as release |
| `docs/context/domains/release-gitops.md@2.0.0` | Release verification | Require image and Argo evidence |
| `docs/context/project/services/velagw.md@2.1.0` | Service-specific context | Focus Go package validation |
| `velagw/MONO2_SUBTREE.md@working-tree` | Upstream and release boundary | Preserve subtree workflow |
| `.ci/AGENTS.md@working-tree` | CI/production authorization | Manual Shanghai sync |
| `docs/context/project/adjacency/argocd-ci-secrets.md@1.0.0` | Release neighbors | Check service overlay and contract test |

## evidence
- Before change, a recent 15-minute NewAPI sample had hundreds of 400 `unexpected EOF`, no NewAPI 5xx, and 429 channel errors largely recovered to 200. VelaGW logs report `upstream_roundtrip_error` 502 without original transport/context detail.
- All Shanghai NewAPI traffic Pods were Ready with zero restarts; CPU and memory were low.
- On 2026-09-29 the Shanghai `velagw-shprod` Application was `Synced/Healthy` at GitOps revision beginning `f6f0a31351bd`; `llmgateway-traffic` was 2/2 on the old image digest beginning `sha256:fb80d5a16886`. The diagnostic patch has not been released.
- On 2026-09-30 the user explicitly authorized commit, push, and Shanghai production release. The isolated source MR is `https://git.woa.com/wisp/mono2/-/merge_requests/4842`; Gongfeng reports commit check success but rejected merge with `Review check not passed` (409). No production action has occurred.

## risks
- Diagnostic logs could leak credentials or produce excess cardinality: use fixed error categories and byte counts only; do not log raw request/error strings.
- The worktree contains unrelated observability edits: stage and review only scoped files.
- Production rollout can disrupt traffic: use the existing manual Shanghai GitOps path and verify image/health before declaring completion.

## validation
- `docker build --target builder -t velagw-diagnostics-builder:local -f velagw/Dockerfile velagw`: passed full `go test ./...` and all Go binary builds.
- `docker build -t velagw-diagnostics:local -f velagw/Dockerfile velagw`: passed the complete image build, including 50 Web tests and TypeScript/production Web build. The image is local only.
- `docker run --rm velagw-diagnostics-builder:local go vet ./...`: passed.
- `python3 -m unittest discover -s .ci/runtime/tests/contract_tests -p test_release_bundle_contracts.py -v`: 102 tests passed.
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`: passed with zero broken first-party links and no warnings.
- `python3 .agents/context/scripts/validate_context.py --build-catalog`: failed due to numerous pre-existing task-pack schema and secret-scan findings. Follow-up scoped check found no findings for either new task document; generated catalog output was restored.
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`: passed; owner review required for the `agent-gateway-runtime` mapping.
- Live log inspection after release, if authorized and reachable.

## decisions
- Add observability only; do not infer a culprit from `unexpected EOF` alone.

## scan_scope
- `velagw/internal/gateway/`, `argocd/services/velagw/shprod/`, `.ci/velagw.yml`.

## scan_output
- Bounded source and manifest searches recorded in the conversation; no isolated scan artifact.

## handoff
- Source implementation and local VelaGW/CI tests complete. The authorized source change is on an isolated latest-master branch and MR !4842, but merge is blocked by Gongfeng's human review check. Request a non-author VelaGW owner review before merging; then allow the service CI build and production promote, maintain manual Shanghai Argo sync, and verify expected GitOps revision, image, and traffic Deployment health.
