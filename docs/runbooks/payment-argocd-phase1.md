# Payment Argo CD Phase 1

这份文档定义 `payment` 的第一阶段接入边界。

## Current Beijing Runtime

北京现网当前的 `deployment/payment`：

- image: `ccr.ccs.tencentyun.com/clawhub/payment:bj8-20260324-4`
- namespace: `user-auth`
- 依赖：
  - `configmap/payment-config`
  - `secret/payment-runtime-secrets`
- 当前 Deployment 不包含：
  - `payment.clawhub.dev/redeploy-at`
  - `wait-db-schema` initContainer

## Phase 1 Rule

第一阶段只接：

- Deployment
- Service
- ConfigMap
- Secret

显式不接：

- migration job
- `wait-db-schema` initContainer
- `Namespace/user-auth`
- `ServiceAccount/user-auth/default`

## Why

这条服务在北京现网与仓库 `payment/k8s/base` 存在 drift。
首轮先纳管现网，不把数据库行为和模板收敛混在一起。
