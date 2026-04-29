# GitOps Phase 2 Backlog

这份清单只回答一个问题：

- 北京已经被统一 Argo CD 控制面 纳管的服务里，哪些还停留在 phase 1
- 每个服务后续要怎么收敛到长期标准

这里的 phase 2，指的是把“先按现网接入”的临时做法收回到统一、可长期维护的单一实现。

## Current State

当前已经接入北京 GitOps 的服务：

- `nextgen-dashboard`
- `gateway-dashboard`
- `admin-gateway`
- `subscription`
- `service-gateway`
- `lightclaw-auth`
- `payment`
- `ai-gateway`
- `session`

## Summary

### 最需要 phase 2 的

- `payment`
- `subscription`
- `lightclaw-auth`
- `ai-gateway`

### 中等优先级

- `service-gateway`
- `admin-gateway`

### 低优先级

- `nextgen-dashboard`
- `gateway-dashboard`
- `session`

## Backlog Matrix

| Service | Current phase | Why still phase 1 | Phase 2 target |
| --- | --- | --- | --- |
| `nextgen-dashboard` | phase 1 | deploy-facing 入口已独立，但仍依赖 `user-auth` namespace 共享边界 | 决定是否拆出独立 namespace；统一 source-facing 与 deploy-facing 目录结构 |
| `gateway-dashboard` | phase 1 | 继续复用 `ai-gateway` namespace；source-facing 仍不是严格 Git 真源 | 决定是否拆 namespace；统一 dashboard 配置来源与 deploy-facing artifact |
| `admin-gateway` | governance complete | 运行态已稳定，当前主要问题不是模板对齐，而是入口 ownership 和变更规则 | 按入口治理规则执行后续 host/TLS/path 变更；不再把 phase 2 当作源模板重写任务 |
| `service-gateway` | governance complete | 运行态已稳定，当前主要问题不是模板对齐，而是公网入口 ownership 和高风险变更治理 | 按入口治理规则执行后续 host/TLS/path 变更；不再把 phase 2 当作源模板重写任务 |
| `subscription` | phase 2 in progress | Deployment 已稳定，migration 仍然在 GitOps 外 | 设计 subscription migration job 的 GitOps 受控接入方式；确认新的 source-facing base 成为长期真源 |
| `lightclaw-auth` | phase 2 in progress | Deployment / Service / internal LB 已稳定，但 migration/seed 已被剥离出主发布链路 | 设计 auth migration/seed 的受控 GitOps 路径；确认新的 source-facing base 成为长期真源 |
| `payment` | phase 2 in progress | Deployment 模板已经开始回收，但 migration 仍未纳回 GitOps | 完成 migration job 的长期接入设计；确认 `payment` source-facing 真源正式替代 phase 1 特殊处理 |
| `ai-gateway` | phase 2 in progress | Deployment / internal ingress 已稳定，但 migration 仍然在 GitOps 外 | 明确 ai-gateway migration 的受控接入方式；确认新的 source-facing base 与 deploy script 成为长期真源 |
| `session` | phase 1.5 | 已补齐 source-facing 资产，但本质上是从现网反推的新服务骨架 | 补完善整服务文档/测试/发布约束；确认 session 目录成为长期 source of truth |

## Service Notes

### `payment`

这是 phase 2 优先级最高的一条，而且已经开始收敛。

原因：

- 北京现网 Deployment 语义和旧版 `payment/k8s/base` 曾经明显漂移
- 现在已经开始收敛：
  - `payment/k8s/base` 已回收到当前现网 Deployment 语义
  - deploy-facing 的 `remove/init/delete` 临时补丁已经可以开始收掉
- 但 migration job 仍然被排除在外

phase 2 要做的是：

- 最终确认新的 `payment/k8s/base` 就是长期 Deployment 真源
- 再决定 migration job 是：
  - 继续剥离
  - 还是进入 GitOps 但改成手工/受控触发

### `subscription`

`subscription` 已经能稳定跑，而且 source-facing base 也开始收敛，但数据库迁移仍然被排除在外。

phase 2 要做的是：

- 设计 migration job 的纳管规则
- 明确：
  - 首次建库
  - 常规 schema 迁移
  - rollback
  这三类动作各自由谁触发

### `lightclaw-auth`

`lightclaw-auth` 的问题不是运行态，而是数据库和 seed 生命周期。当前 source-facing base 已经收掉了 migration/seed job。

phase 2 要做的是：

- 把 migration / seed job 重新设计成长期可接受的 GitOps 行为
- 明确：
  - seed 是一次性
  - 还是幂等受控作业

### `ai-gateway`

这条现在已经绿，而且 phase 2 也已经开始收敛。

phase 2 要做的是：

- `ai-gateway/k8s/base` 已收回到当前现网运行模板
- 资源规格也已按当前北京可调度模板收平
- 但 migration job 仍然在 GitOps 外

phase 2 余项：

- 设计 migration job 的长期接入规则
- 确认 deploy 脚本和 source-facing overlay 已经完全摆脱 migration 占位字段

### `service-gateway`

`service-gateway` 这条当前已经不属于“源码树与现网 drift”问题。

当前结论：

- 运行态已经稳定绿
- deploy-facing 和当前现网入口规则已经对齐
- 后续重点不在 phase 2 模板改写，而在入口治理

后续按：

- [gitops-ingress-governance.md](gitops-ingress-governance.md)

执行。

### `admin-gateway`

`admin-gateway` 也已经从“模板收敛问题”转成“入口治理问题”。

当前结论：

- 运行态已经稳定绿
- `lightclaw-gateway` 共享 bootstrap ownership 已经明确回到 `admin-gateway`
- 后续重点是公网入口治理，而不是继续重写 source-facing 模板

后续按：

- [gitops-ingress-governance.md](gitops-ingress-governance.md)

执行。

## Governance Follow-ups

除服务本身以外，还有 3 类平台 backlog：

1. 共享 bootstrap ownership

要明确谁拥有：

- `user-auth` namespace / default SA
- `lightclaw-gateway` namespace / default SA
- `ai-gateway` namespace / default SA

2. `root/mono` 的长期定位

要明确它最终是：

- 继续做“deploy-facing + 必要 source-facing 子集”
- 还是收成完整 mono 镜像

3. migration job 的统一策略

现在多个服务都说明了同一个问题：

- 首轮接入可以不带 migration
- 但长期不能一直跳过

所以最终需要一条统一规则，至少覆盖：

- `payment`
- `subscription`
- `lightclaw-auth`
- `ai-gateway`

统一规则文档：

- [gitops-migration-governance.md](gitops-migration-governance.md)

## Recommended Order

如果现在进入 phase 2，我建议顺序是：

1. `payment`
2. `subscription`
3. `lightclaw-auth`
4. `ai-gateway`
5. `nextgen-dashboard`
6. `gateway-dashboard`
7. `session`

这个顺序的逻辑是：

- 先解决最明显的源码树/现网 drift
- 再解决 migration / seed
- 最后才收入口治理和轻量服务目录整理
