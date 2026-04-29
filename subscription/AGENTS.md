# Subscription Agent Guide

`subscription` 的正式发布模型已经改成：

- source-facing:
  - `subscription/k8s/base/`
  - `subscription/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/subscription/<env>/`
  - `argocd/apps/<env>/subscription.yaml`

正式发布只认 `Argo CD`。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service subscription --env <env> --tag <tag>`
- DB migration：
  - `scripts/run_gitops_db_job.py`
  - 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 约束

- `generated/` 一律不提交 Git
- migration / seed 不再属于 service-local 正式发布路径
