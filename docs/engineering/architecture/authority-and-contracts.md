# 权威来源与机器契约

文档的职责是解释边界与决策，不与代码争夺真源。发生冲突时按下表处理。

| 优先级 | 权威 | 典型位置 | 可以证明什么 |
|---:|---|---|---|
| 1 | 运行时代码与测试 | 各服务 `internal/`、`src/`、测试 | 当前实现和受测行为 |
| 2 | 生成机器契约 | `api/openapi.yaml`、Proto、Schema、migration | API/字段/协议/数据库结构 |
| 3 | 环境与 GitOps Manifest | `infra_pulumi/envs/`、`argocd/`、Kustomize | 期望环境和部署状态 |
| 4 | Owner 审阅的工程文档 | `<service>/docs/`、`docs/engineering/` | 非代码可直接推出的边界、流程、原因 |
| 5 | Agent Context Pack | `docs/context/` | 面向任务的短派生摘要与路由 |
| 6 | 工作产物与历史材料 | `docs/superpowers/`、proposal、handover、archive | 决策过程和时间点背景 |

## 机器契约索引

- 身份：`user/auth/api/openapi.yaml`
- 订阅：`subscription/api/openapi.yaml`
- 支付：`payment/api/openapi.yaml`
- 工单：`ticket/api/openapi.yaml`
- Sandbox：`sandbox/openapi.yaml`
- 计费代理：`cloudladdergateway/proto/cloudladdergateway/v1/gateway.proto`
- 环境：`infra_pulumi/envs/tencentcloud/<env>/inventory.yaml`
- 部署：`argocd/apps/<env>/` 与 `argocd/services/<service>/<env>/`

## 外部 authority

腾讯云计费、CAM、Cloud API、外部支付与平台实时规则不可能仅靠仓库长期保持正确。它们必须登记在 `.agents/context/external-sources.yaml`，记录 owner、版本/查询方式和不可用策略；文档引用来源，不复制秘密或易漂移响应。

## 冲突处置

发现两个同级 authority 冲突时停止实施，记录文件、revision、环境和复现命令，交给对应 Owner 决定。不得用“两个都可能对”拼接出新的运行规则。
