# Payment Argo CD Cutover

`payment` 是北京接入里第一条明显偏离源码树当前 `k8s/base` 的服务。

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

北京现网当前的 `payment-runtime-secrets` 只包含：

- `AI_GATEWAY_ADMIN_TOKEN`
- `LIGHTCLAW_INTERNAL_SERVICE_TOKEN`
- `PAYMENT_DB_PASSWORD`

## Source-facing Drift

仓库里的 `payment/k8s/base` 与现网不同：

- base 里包含 migration job
- base 里要求 `MYSQL_ROOT_PASSWORD`
- base 里的 Deployment 包含 `wait-db-schema` initContainer
- overlay 还依赖动态生成的 `PAYMENT_MIGRATION_JOB_NAME`

这说明：

- 不能把当前源码树里的 `payment/k8s/base + overlays/beijing-sandbox` 直接当成北京现网的 GitOps 真源

## Safe First Migration Rule

`payment` 的第一阶段应当：

- 先纳管北京现网当前运行模板
- 不主动引入 migration job
- 不主动引入新 initContainer
- 不主动改变 secret 契约

等北京现网在 Argo 下稳定后，再做第二阶段收敛：

- 统一 Deployment 模板
- 再决定是否把 migration job 收回到正式 GitOps 路径
