---
id: context-rules-matrix
type: project
scope: Engineering landing and verification for the 23 context-engineering rules.
triggers: ["23 rules", "context governance", "context audit"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/23-rules-matrix.md
  - .agents/context/context-routing.yaml
status: active
reviewed_at: 2026-08-25
review_due: 2026-11-23
revision: 2.0.0
precedence: project
derived: true
---

# 23 条上下文工程规则实现矩阵

成熟度沿用原方案：`ADOPT` 是当前标准，`PILOT` 需要试点证据，`RESEARCH` 只定义研究边界。实现状态单独计算：`implemented` 表示仓库已有可执行机制和校验，`partial` 表示只有部分闭环，`design-only` 表示尚无运行时能力。

## 与全仓文档系统的关系

这 23 条规则主要治理 Agent 如何发现、加载、消费、压缩和沉淀 Context，并没有完整规定“项目文档应该放在哪里”。因此本轮没有硬把服务文档、架构文档、产品文档和工作产物塞进第 24 条规则，而是增加互补的 Documentation System：

- 每个服务共置 `README.md`、短 `AGENTS.md`、`catalog-info.yaml` 与 `docs/README.md`；
- 跨服务架构、Domain、Journey、Platform、Operations、Governance 与 ADR 集中在 `docs/engineering/`；
- 产品真源留在 `frontend/src/content/docs/`，工作产物留在 `docs/superpowers/`、`docs/proposals/`、`docs/handover/`，并按生命周期退出当前事实层；
- `docs/context/` 只从正式知识派生，`.agents/context/` 只负责路由、Schema、Catalog、校验和隔离。

规则 1、2、12、13、18、19 约束 Agent 入口、权威和消费证据；Documentation Policy、Map、Service Catalog 与 ADR 负责补齐人类文档的类型、分布、owner、链接和生命周期。两套评分独立，不能用 51 条 Context Catalog 覆盖率代替 1,811 份仓库文档母集。

| # | 成熟度 | 规则 | 仓库落点 | 验收证据 | 当前实现状态 |
|---:|---|---|---|---|---|
| 1 | ADOPT | 入口文件是路由，不是百科全书 | 根和局部 `AGENTS.md` 只保留 P0、加载算法、命令与专题入口 | 根入口不超过 8 KiB，任一祖先指令链不超过 16 KiB | implemented |
| 2 | ADOPT | 规则分层、作用域明确、近者优先 | Team / Project / Domain / Service / Task 的 `precedence` 与最近 `AGENTS.md` | Schema 校验层级；审计递归计算全部祖先入口 | implemented |
| 3 | ADOPT | 默认动态发现，不默认全量注入 | `.agents/context/context-routing.yaml` 的多 Pack 路由和延迟路径 | 40 个跨域/服务/精确路径 smoke case；evaluation 永不进入路由 | implemented |
| 4 | PILOT | 一个窗口只承载一个主要目标 | Task Pack 固定 `goal`、`non_goals`、需求/接口/数据入口、当前设计与有界历史；跨域可加载多个必要 Pack | 模板和 active Pack 由 Validator 检查字段；跨会话任务结果仍需持续抽检 | partial |
| 5 | RESEARCH | 窗口使用率约 40% 后主动 compact | Checkpoint 模板仅定义阶段边界；运行时阈值尚未接入 | 未来需记录窗口压力、事实保留率和 compact 后成功率 | design-only |
| 6 | PILOT | 先清旧工具结果，再做有损 compact | Checkpoint `discard` 明确可重取扫描和过期输出 | 当前可人工记录；尚无 `tool_clear` 运行时事件与释放 token 证据 | partial |
| 7 | PILOT | compact 必须可恢复 | Checkpoint `restore`、验证/未验证事实和下一动作 | 模板可恢复任务；尚缺摘要 hash 与自动恢复回归 | partial |
| 8 | PILOT | 大规模检索与扫描下沉隔离任务 | Task Pack `scan_scope` / `scan_output` 约束只返回证据摘要 | 当前有契约；尚未强制子任务隔离和统计主窗口节省量 | partial |
| 9 | PILOT | 交接结构化，不传完整聊天 | Task Pack 和 Checkpoint 记录目标、事实、风险、验证、下一步 | 至少一个真实 Task Pack 有完整 `context_receipt`；仍需跨会话复现样本 | partial |
| 10 | ADOPT | 多路检索，不用单一向量检索冒充万能 | 路由已实现 exact path、deferred path、symbol、keyword 四通道 | 输出各通道命中证据；语义、图关系、历史通道尚未接入 | partial |
| 11 | ADOPT | 精确命中不能被语义结果覆盖 | 路径权重 30、显式文件 20、符号 5、关键词 2 | 精确路径 smoke case 必须出现在路由结果中 | implemented |
| 12 | ADOPT | 上下文必须有来源、版本与权威度 | 每份正式 Context 含 owner、authority、revision、review 日期和事实源；工程文档另由 Service Catalog 与 Documentation Policy 治理 | 58/58 非评测 Context 通过 Schema；23/23 服务记录有 owner、domain 与 source docs | implemented |
| 13 | ADOPT | 生成 Wiki 只能是派生视图 | Context Catalog 由 Validator 生成并记录源文件 SHA256；Domain/Service Context 回链正式工程文档 | 58/58 Context Catalog 一致，5/5 Domain 与 23/23 Service Context 派生；不把 Catalog 数量冒充全仓文档覆盖 | implemented |
| 14 | RESEARCH | 记忆写入必须经过验证门禁 | `candidates/` 与 `lifecycle.yaml` 定义 candidate → pilot → active → stale/retired | 尚无真实 owner 接受记录、拒绝记录和自动发布门禁 | design-only |
| 15 | ADOPT | 保留有效失败证据，压缩重复噪声 | `feedback/` 保存失败条件、影响、根因、修复和回归 | 路由漏召回与审计自评分案例可回链到具体变更 | implemented |
| 16 | PILOT | 提示前缀与工具定义必须稳定 | `.agents/context/tool-contracts.yaml` 版本化四个上下文工具契约 | 静态文件存在；尚缺参数/返回/错误码的运行时契约回归 | partial |
| 17 | PILOT | 外部化记忆：状态落盘、Todo 复述、保留失败 | Task Pack、Checkpoint、feedback 分别承载状态、恢复和失败 | 已能人工恢复；尚无 Todo 与会话状态自动同步 | partial |
| 18 | ADOPT | 默认检索优先，允许受控回退 | 先路由；无命中后执行有界 `rg`，记录失败查询再扩大范围 | 路由器输出 fallback 指令；尚缺统一 `context.fallback` trace | partial |
| 19 | PILOT | 观测取了什么、注入了什么、用了什么 | Task Pack `context_receipt` 记录读取文件、原因、用途与 revision/hash | active Pack 的 receipt 字段由 Validator 检查；尚无 retrieve/rerank/assemble/utilization 运行时漏斗 | partial |
| 20 | ADOPT | 失败必须回流评测、索引或规则 | feedback 分类并链接到 route、rule、content 或 evaluation 修复 | 每个关闭案例包含失败证据、改动文件和回归命令 | implemented |
| 21 | PILOT | 模型按难度与可验证性路由 | 仅在策略中保留风险、推理深度、验证能力、预算四因素 | 无 requested/actual model trace 和稳定对比证据 | design-only |
| 22 | ADOPT | 工具集要少而精 | tool contracts 只保留路由、校验、审计、有界搜索四类接口 | 当前核心工具有输入输出和失败策略；尚缺仓库级使用指标 | partial |
| 23 | PILOT | 经验经人工确认后增量沉淀 | candidate 要求来源、范围、owner、过期时间和接受记录 | 生命周期规则已定义；尚缺月度接受率、拒绝原因和复用数据 | partial |

## 状态更新规则

- 只有对应“验收证据”可由仓库命令或真实 Task Pack 复现时，才能把状态提升为 `implemented`。
- `ADOPT` 但实现为 `partial` 的项目是优先建设缺口，不得通过改表格消除扣分。
- Runtime trace、自动 compact、模型路由和自动记忆晋级在实现前不得进入默认 Context Pack，也不得作为本轮效果结论。
