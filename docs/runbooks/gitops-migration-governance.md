# GitOps Migration Governance

这份文档定义 `payment` / `subscription` / `lightclaw-auth` / `ai-gateway` / `ctl` / `sandbox` 的统一 migration/seed 受控 GitOps 规则。

目标不是把数据库变更塞回默认发布主链，而是明确：

- 什么属于 steady-state deployment
- 什么属于 database lifecycle
- 这些动作各自由谁触发

## Core Split

统一把工作分成两类：

### 1. Steady-state workload

由常规 `Application` / root app 负责：

- Deployment
- Service
- Ingress / TkeServiceConfig
- ConfigMap
- Secret
- HPA

特点：

- 可以自动同步
- 可以持续自愈
- 应该保持幂等

### 2. Database lifecycle

不进入默认自动同步主链：

- migration job
- seed job
- bootstrap db/user/grant 这类一次性或半一次性动作

特点：

- 不是持续幂等资源
- 经常伴随不可逆 schema 变化
- 失败时回滚成本高

所以长期规则是：

- **migration / seed 不进入默认 root app 自动同步主线**

## Unified Rule

对这 4 条服务统一适用：

- `payment`
- `subscription`
- `lightclaw-auth`
- `ai-gateway`
- `ctl`
- `sandbox`

规则：

1. 默认 GitOps 主线只管 steady-state workload
2. migration / seed 必须走受控触发
3. 受控触发必须明确目标 revision
4. 同一次服务发布，不默认自动触发 migration / seed
5. migration / seed 的执行结果必须可审计

## Recommended Operating Model

### Default path

1. 开发者修改代码 / config / secret
2. 更新 deploy-facing artifact
3. Argo 自动同步 steady-state workload
4. 不自动触发 migration / seed

### Controlled migration path

1. 维护者确认目标 commit / revision
2. 通过受保护入口手工触发 migration job
3. 观察 job 成功 / 失败
4. 再决定是否继续后续 rollout

### Controlled seed path

1. 只有确实存在幂等 seed 需求时才允许
2. 必须明确说明 seed 的幂等边界
3. 不允许把 seed 混进 Deployment 启动路径

## Service-specific Notes

### `payment`

长期建议：

- 默认主线只管 `Deployment/Service/ConfigMap/Secret`
- migration job 单独受控触发
- 当前没有正式 seed 需求

### `subscription`

长期建议：

- 默认主线只管 steady-state workload
- migration job 单独受控触发
- 套餐目录和业务数据不走部署时 seed

### `lightclaw-auth`

长期建议：

- 默认主线只管 `lightclaw-auth` Deployment / Service / internal LB
- migration job 受控触发
- seed job 必须先重新定义幂等边界，才能重新纳回受控路径

### `ai-gateway`

长期建议：

- 默认主线只管 `gateway-backend` / internal ingress / service / config / secret
- migration job 单独受控触发
- 不允许再把 migration 行为混进 steady-state 发布

### `ctl`

长期建议：

- 默认主线只管 `ctl-api` / `ctl-service` / `ctl-bypass` / internal LB / config / secret
- migration job 单独受控触发
- migration 依赖的 `ctl/migrations/` 应由平台级 DB job 临时打包，不回到 steady-state Kustomization
- 本地手工触发时，执行 checkout 必须与目标 `revision` 一致

### `sandbox`

长期建议：

- 默认主线只管 `sandbox-api` / `sandbox-worker` / `sandbox-worker-sharded` / ingressproxy / config / secret / ingress
- migration job 单独受控触发
- `wait-db-schema` 这类 initContainer 可留在 steady-state workload，作为 schema 就绪保护，但不意味着 migration job 回归自动同步主线

## Trigger Contract

长期建议统一成下面这种 contract：

- 输入：
  - service name
  - target environment
  - target revision
  - operation type: `migration` / `seed`
- 输出：
  - job name
  - started_at / finished_at
  - success / failure
  - logs pointer

这条 contract 可以由后续 GitLab CI / runbook / 手工命令实现，但语义要统一。

## Hard Rules

禁止：

- 在默认 root app 自动同步里直接跑 migration / seed
- 把 migration / seed 混进 Deployment 启动路径
- 用“每次发布生成一个 job”但没有受控审批和审计

允许：

- 在明确 revision 基础上手工触发受控 migration
- 保持 migration / seed 仍在 Git 中定义，但不进入默认自动同步路径

## Verification

统一验证点：

1. steady-state app 仍可在不触发 migration 的情况下保持 `Synced / Healthy`
2. migration / seed 不会被 root app 自动创建
3. 受控触发时，job 目标 revision 清晰可追溯
4. 失败时不会误导为“服务已完成发布”

## Follow-up

这份规则先定义边界，不直接决定最终触发器实现。

后续仍要补一层具体实现：

- GitLab CI 入口
- runbook 命令
- job 命名约定
- 日志归档位置

当前最小实现已经落在：

- [gitops-db-job-runbook.md](gitops-db-job-runbook.md)
