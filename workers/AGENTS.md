# AGENTS.md - workers

本目录包含 Temporal worker。将 worker 变更视为 backend infrastructure 变更：保持 workflow determinism、compensation path 和 deployment rollback behavior 明确。

## Release 范围

- source-facing Kubernetes 位于 `workers/k8s/base` 和 `workers/k8s/overlays/<env>`。
- deploy-facing generated file 必须位于 source overlay 之外；`generated/` 仅是 local/CI material。
- CI image publishing 使用 `.ci/runtime/commands/build_release_image.py --service workers --env <env> --tag <tag>`。
- Docker image 必须同时包含 `rescue-exporter` 和 `rescue-uploader`；production worker 不得在 runtime 编译 uploader binary。

## Runtime

- 默认 command 是 `rescue-exporter worker`。
- Temporal auth 必须作为 runtime secret 提供，不能作为 command-line argument。
- Tencent Cloud credential、rescue password 和 COS signing secret 必须是 Kubernetes secret。
- `TEMPORAL_DEPLOYMENT_NAME` 和 `TEMPORAL_WORKER_BUILD_ID` 可选，但若设置其一，必须同时设置另一个以启用 Temporal Worker Versioning。

## 验证

- code 变更后，在 `workers/` 内运行 `go test ./...` 和 `go vet ./...`。
- release metadata 变更时，从 repo root 验证 release bundle manifest。
- container 变更时，Docker 可用则构建 Docker image。
