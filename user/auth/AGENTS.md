# User Auth Agent Guide

`user/auth` 的正式发布模型已经改成：

- source-facing:
  - `user/auth/k8s/base/`
  - `user/auth/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/lightclaw-auth/<env>/`
  - `argocd/apps/<env>/lightclaw-auth.yaml`

正式发布只认 `Argo CD`。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service user-auth --env <env> --tag <tag>`
- DB migration / seed：
  - `python3 .ci/runtime/commands/run_gitops_db_job.py`
  - 历史 DB job 模板已退役；当前以脚本和 runbook 为准

## 约束

- `migration / seed` 不再是默认发布路径的一部分
- 不要把 MySQL seed 放到应用启动路径里
- runtime secret 通过 GitOps secret 主线管理，不再依赖 service-local 正式发布脚本
- 继续默认依赖集群级 pull credential
