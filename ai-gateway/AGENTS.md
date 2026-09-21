# AI Gateway Deploy Agent Guide

`ai-gateway` 的正式发布模型已经改成：

- source-facing:
  - `ai-gateway/k8s/base/`
  - `ai-gateway/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/ai-gateway/<env>/`
  - `argocd/apps/<env>/ai-gateway.yaml`

正式发布只认 `Argo CD`。

## 保留能力

- 镜像构建：
  - `python3 .ci/runtime/harness_ci/commands/build_release_image.py --service ai-gateway --env <env> --tag <tag>`
- DB migration：
  - `scripts/run_gitops_db_job.py`
  - 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 约束

- migration Job 当前不属于 service-local 发布主线
- `gateway-dashboard` 已独立到自己的发布链路
- `generated/` 一律不提交 Git

## CI 触发记录

- 2026-07-08：为 shprod ai-gateway 发布镜像构建重新触发 CI。
- 2026-07-08：发布镜像可见性门禁重试修复后重新触发 CI。
