# Nextgen Dashboard Agent Guide

`nextgen-dashboard` 的正式发布模型已经改成：

- source-facing:
  - `nextgen-dashboard/k8s/base/`
  - `nextgen-dashboard/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/nextgen-dashboard/<env>/`
  - `argocd/apps/<env>/nextgen-dashboard.yaml`

正式发布只认 `Argo CD`。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service nextgen-dashboard --env <env> --tag <tag>`

## 约束

- `generated/` 一律不提交 Git
- runtime secret 统一经 `SSM -> sops -> ksops`
