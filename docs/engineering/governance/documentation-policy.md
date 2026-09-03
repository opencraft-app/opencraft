# 文档治理规则

本规则是 mono2 的通用文档建设标准。目标不是让每个目录都多一份 Markdown，而是让研发、产品、运维和 Agent 能从同一套权威知识中找到答案，并能判断来源、责任、时效、验证方式和适用边界。

## 核心原则

1. 一个事实只有一个权威入口。运行时代码和测试、生成的 OpenAPI/Proto/Schema、环境与 GitOps Manifest 依次高于工程文档；文档解释原因、边界和验证方式，不复制整份机器契约。
2. 知识靠近 Owner。单服务知识与代码共置，跨服务知识集中维护，产品文档保留区域真源，Agent Context 只做派生消费。
3. 按读者任务组织，不按文件格式堆目录。同一主题分别需要概念、操作、参考或故障内容时拆开，避免一篇“万能 README”。
4. 文档变更与行为变更一起评审。源码、契约或交付路径变化时，同一变更必须更新对应正式文档或明确说明为什么不需要。
5. 结构覆盖不等于内容质量。Validator 证明入口、分类和链接有效；事实正确性、时效与读者任务成功率仍需 Owner 审阅或抽检。

## 文档放置矩阵

| 文档类型 | 解决的问题 | 标准位置 | 权威来源与边界 |
|---|---|---|---|
| 服务入口 | 这个服务做什么，去哪里继续读 | `<service>/README.md` | 面向所有贡献者的稳定入口，不承载 Agent 专属规则 |
| Agent 入口 | 当前路径有哪些硬约束，要加载什么 | 最近的 `<path>/AGENTS.md` | 只做短路由，不写百科全书 |
| 服务知识 | 服务边界、权威入口、验证与运维去哪里 | `<service>/docs/README.md` 及必要子文档 | 与服务代码共置；复杂服务按架构、how-to、reference、runbook 拆分 |
| 服务目录 | Owner、lifecycle、domain、依赖、接口、发布与生成路径 | `<service>/catalog-info.yaml` 与 `docs/engineering/catalog/`（`.ci` 例外：BK-CI 把 `.ci/**/*.yaml` 当流水线候选，改用 `.ci/catalog-info.manifest`，内容仍是同一 JSON 契约） | 机器可读责任和关系，不复制正文 |
| 系统架构 | 系统、组件、部署和权威关系如何组成 | `docs/engineering/architecture/` | 跨服务稳定结构，回链机器契约 |
| Domain | 稳定业务概念、归属与跨服务不变量是什么 | `docs/engineering/domains/` | 一个 Domain 一个 canonical 入口 |
| Journey | 一个用户或系统流程如何跨越多个服务 | `docs/engineering/journeys/` | 聚焦顺序、失败边界和端到端验证 |
| How-to | 如何完成一个明确目标 | 服务 `docs/` 或 `docs/engineering/platform/` | 前置条件、步骤、结果校验、失败处理 |
| Reference | 字段、配置、命令和状态有哪些 | 生成契约旁的索引或引用页 | OpenAPI/Proto/Schema/CLI 输出是最终真源 |
| Runbook | 如何发现、缓解、恢复和回滚故障 | `docs/engineering/operations/` 或既有 `docs/runbooks/` | 必须区分只读诊断、写操作、回滚与升级条件 |
| Decision | 为什么选择当前方案 | `docs/engineering/decisions/ADR-*.md` | 记录背景、选择、替代方案、后果和状态 |
| Product | 客户看到什么、如何使用产品 | `frontend/src/content/docs/` | 国内与国际区域真源隔离，按 `lv-docs` Skill 同步生成物 |
| Work | 尚在推进的方案、计划、交接和会议结论 | `docs/superpowers/`、`docs/proposals/`、`docs/handover/` | 不是默认运行事实；必须进入生命周期状态 |
| Agent Context | 哪些短事实应按任务动态加载 | `docs/context/` | 从正式工程/产品知识派生，禁止创造无来源事实 |

## 每个主要服务的最低契约

23 个主要服务都必须具备四个入口：

- `README.md`：服务定位与贡献者入口；
- `AGENTS.md`：P0 边界、路由命令和必须读取的最小上下文；
- `catalog-info.yaml`：Owner、lifecycle、Domain、接口、依赖、发布路径和生成路径；
- `docs/README.md`：至少包含服务定位、`权威入口`、一种边界/不变量章节和`验证`。

`docs/README.md` 不是占位文件：正文少于 600 字节、缺少上述章节或含 `TBD`、`TODO`、`待补`时，Validator 直接失败。复杂服务出现三个以上独立读者任务或单文件难以审阅时，再拆为职责单一的架构、how-to、reference 或 runbook；小服务不为追求目录数量强行拆分。

## 权威、Owner 与元数据

- 事实冲突时按“代码与测试 > 生成契约 > 环境/GitOps Manifest > Owner 审阅工程文档 > derived Context > 工作产物与历史材料”处理；不能拼接折中答案。
- Owner 表示审阅责任队列。不得依据提交次数猜个人 Owner；团队归属变化只更新 Service Catalog，再由派生视图消费。
- 正式知识必须能回链事实源、影响范围和验证命令。Context Pack 额外要求 `owner`、`authority`、`revision`、`reviewed_at`、`review_due`、`precedence`、`derived` 与 `source_of_truth`。
- 外部云、计费、供应商或政策事实只登记来源、版本和失效策略，不把动态外部状态复制为仓库真相。

## 生命周期与退出机制

工作产物必须处于以下一种状态：

- `active`：仍在实施，不能作为完成事实；
- `accepted`：决策或结论已进入代码、契约或正式文档；
- `superseded`：被新文档替代，必须回链替代者；
- `archived`：只保留审计价值，不进入默认导航和运行时 Context。

功能完成后，计划、交接或会议记录中的稳定结论应晋级到服务文档、Domain、Journey、Runbook 或 ADR；原工作产物再标记 `accepted`、`superseded` 或 `archived`。过期正式文档必须修订、显式降级或移出入口，不能静默漂移。

## 生成物、上游与评测

- 不直接编辑 `.fumadocs-content`、生成代码或生成契约；修改源文件后运行对应生成命令并验证产物。
- 不批量重写 vendor/subtree 上游正文；只维护本地 pin、集成、差异、同步和验证边界。
- 评测数据、Gold、模型回答、评分和原始敏感日志永远位于运行时 Context 之外。
- 例外链接必须在 [文档地图](documentation-map.yaml) 登记精确来源、目标和理由，不能靠忽略整个目录掩盖一方死链。

## 变更工作流

1. 用 [文档地图](documentation-map.yaml) 和 [Service Catalog](../catalog/services.yaml) 确定文档类型、位置和 Owner。
2. 先核对代码、测试、生成契约或 Manifest，再修改正式文档；无法验证的内容标为未知，不猜测。
3. 对历史相关任务，先由功能族索引定位当前设计，再以路径和需求标识有界查询 Git、MR、TAPD/Issue；不可访问来源必须明确为未知。
4. 跨服务行为变化更新对应 Domain/Journey；服务局部变化更新共置文档；用户可见变化按区域更新产品文档。
5. 命中 `.agents/context/change-impact.json` 时，至少同步一份映射的正式设计文档并运行 docs-impact；该检查不替代 Agent 的语义判断和 Owner 的 MR 审阅。
6. 正式知识更新后，再更新 derived Context、route 和 Task Pack `context_receipt`。
7. 运行静态校验和受影响服务测试；交付时分开报告源码证据、生成/构建证据、GitOps 证据和真实运行态证据。

## 验证

```bash
python3 .agents/context/scripts/validate_documentation.py --repo . --format json
python3 .agents/context/scripts/validate_context.py --build-catalog
python3 .agents/context/scripts/validate_change_impact.py --repo . --staged
python3 -m unittest discover -s .agents/context/tests -v
python3 -m unittest discover -s .agents/skills/context-audit/tests -v
python3 .agents/skills/context-audit/scripts/audit_context.py --repo . --format json
```

Repository Documentation 结构得分只评价盘点分类、服务入口、工程层级、链接和 Context 派生接口。未建立逐文事实/时效抽检与读者任务验证前，`content_quality_scope` 必须保持 `structural-only`，不得宣称所有正文已经准确、最新或能提升模型效果。
