# Gateway Dashboard Agent Guide

`gateway-dashboard` 的正式发布模型已经改成：

- source-facing:
  - `gateway-dashboard/k8s/base/`
  - `gateway-dashboard/k8s/overlays/<env>/`
- deploy-facing:
  - `argocd/services/gateway-dashboard/<env>/`
  - `argocd/apps/<env>/gateway-dashboard.yaml`

正式发布只认 `Argo CD`。

## 保留能力

- 镜像构建：
  - `python3 scripts/build-release-image.py --service gateway-dashboard --env <env> --tag <tag>`

## 约束

- `gateway-dashboard` 的公网入口仍经 `admin-gateway`
- 历史 direct-access 直连清单已删除，不再属于正式主线
- `generated/` 一律不提交 Git

<!-- 2026-07-08 重新触发：billing 依赖 rollout 后发布 shprod gateway-dashboard。 -->
<!-- 2026-07-21 重新触发：auth billing migration MR 后运行 shprod gateway-dashboard CI。 -->
