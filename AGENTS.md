# LightVela mono2 Agent 入口

这是 `git.woa.com/wisp/mono2` 的团队 Context 入口，定义硬边界、路由和任务状态；它不是百科全书。

## 仓库身份

LightVela 是多语言 monorepo。国内生产站为 `lightvela.com`，国际生产站为 `lightvela.ai`；源码分支是 `master`，Argo CD 跟踪 `gitops` 上面向部署的变更。

主要区域：

| 区域 | 目录 |
|---|---|
| 前端 | `frontend/`, `frontend-ds/`, `nextgen-dashboard/`, `gateway-dashboard/` |
| 身份与商业化 | `user/auth/`, `shadow/`, `subscription/`, `payment/`, `trade/` |
| Agent 与网关运行时 | `cloudagent/`, `ai-gateway/`, `velagw/`, `velalink/`, gateway services |
| 控制与沙箱 | `ctl/`, `sandbox/` |
| 交付与基础设施 | `argocd/`, `.ci/`, `infra_pulumi/` |

仅当任务需要跨服务定位时，读取[仓库地图](docs/context/project/repository-map.md)。

面向研发、产品和运维的人读正式知识从 [Vela 工程文档](docs/engineering/README.md) 进入；服务责任和共置文档由 [Service Catalog](docs/engineering/catalog/services.yaml) 路由。`docs/context/` 是它们的短派生消费层，不是另一套平行真相。

## P0 边界

1. 永不提交或输出 secret、token、私钥或已解密 payload 值。
2. 没有最新命令证据，不得宣称完成。
3. 除非本次用户请求明确授权，不得变更生产、GitOps、云资源或外部服务。
4. 交接前须运行变更服务的 lint、类型检查和测试门禁。
5. Git commit、push、MR、发布和生产操作必须得到用户明确确认。
6. 源码变更不等于发布完成。GitOps 发布要求预期 Argo revision、镜像以及 `Synced`、`Healthy` 状态。

## Context 加载

对任何非简单任务，在实现规划前先运行路由器，再用一条命令只读取路由结果中的 `must_read` 文件和最近的服务级 `AGENTS.md`。

```bash
python3 .agents/context/scripts/validate_context.py --route "<task or path>"
```

随后：

1. 仅当任务触及该边界时读取 deferred path。
2. 在 Task Pack 的 `context_receipt` 中记录实际读取的每份 context 文件。
3. 若没有 Pack 匹配，跳过 context 读取，先执行 bounded exact search；仅在记录失败 query 后才能扩大范围。
4. 对历史改动、修复或文件定位：读完全部 `must_read` 后，在路由相关目录执行一次有界精确搜索；再从 `docs/context/project/adjacency/` 选择一张相关卡，检查卡中一个测试、生成物、配置或部署邻居。卡片不能替代源码定位。

运行时 Domain 如下：

| Domain | Pack |
|---|---|
| 身份与访问 | [identity-access](docs/context/domains/identity-access.md) |
| 订阅与权益 | [subscription-entitlements](docs/context/domains/subscription-entitlements.md) |
| Agent、网关与运行时 | [agent-gateway-runtime](docs/context/domains/agent-gateway-runtime.md) |
| 站点与环境路由 | [site-environment-routing](docs/context/domains/site-environment-routing.md) |
| 发布与 GitOps | [release-gitops](docs/context/domains/release-gitops.md) |

`docs/context/evaluation/` 和评分数据仅用于评测，绝不能进入运行时路由。

## Task Context

任何会改变行为、跨越服务边界或需要超过一个验证步骤的任务，都要创建 Task Pack。使用 [TASK-TEMPLATE.md](docs/context/tasks/TASK-TEMPLATE.md)，保持一个主要目标和明确 non-goals。

受影响路径命中 `.agents/context/change-impact.json` 时，先在 Task Pack 定位当前设计与相关历史，再同步更新至少一份映射的正式设计文档；交接前运行 `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。该检查只约束变更集，语义仍由 Agent 与 Owner 复核。

在 context 压缩前、交接前、三次检索或验证失败后，以及切换目标 Domain 前，更新 [CHECKPOINT-TEMPLATE.md](docs/context/tasks/CHECKPOINT-TEMPLATE.md)。

## 冲突与权威

运行时源码和测试高于摘要；生成的 API contract 高于文档；环境与 GitOps manifest 高于一般交付说明。经 owner 审阅的 context pack 可解释无法从代码推导的事实，但不得覆盖源码。外部云/计费/API authority 登记在 [external sources](.agents/context/external-sources.yaml)，不得复制为仓库事实。

若权威来源冲突，停止并报告冲突；不得自行综合折中结论。

## Skills

共享 Skill 位于 `.agents/skills/`。仅在任务匹配其 trigger 时读取相应 `SKILL.md`。Skill 必须保持有界，且不得重复仓库 context。

## 验证

```bash
python3 .agents/context/scripts/validate_documentation.py --repo . --format json
python3 .agents/context/scripts/validate_context.py --build-catalog
python3 -m unittest discover -s .agents/context/tests -v
python3 -m unittest discover -s .agents/skills/context-audit/tests -v
python3 .agents/skills/context-audit/scripts/audit_context.py --repo .
```

服务变更除 context 门禁外，还要运行该服务自己的 lint/type/test 命令。
