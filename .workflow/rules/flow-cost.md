# Flow Cost & Model Routing Rules（成本与模型分层）

> 按需读取。本文件定义 S/M/L 任务的流程强度与模型分流，目标是让小任务轻跑、大任务完整跑。
>
> **本文件是"每批任务上限"与"模型路由"的唯一权威来源。** `.workflow/project.yaml` 的
> `workflow.flow_profiles.*.max_batch_tasks` 与 `workflow.model_routing` 是本规则的机器可读镜像，
> 二者不一致时以本文件为准；其他 agent / 命令文档不得再硬编码批次数字或模型名，应引用本文件。

## 每批任务上限（权威）

| 规模 | 每批任务上限 | 说明 |
|---|---:|---|
| S | 3 | S 级通常对应单个任务；批次上限沿用统一值 3 |
| M | 3 | 每批 ≤ 3 个任务，避免上下文溢出 |
| L | 3 | 每批 ≤ 3 个任务；L 的"完整"体现在 review/archive/leader，而非更大批次 |

## 默认策略

| 规模 | 启动 | Review | Archive | Metrics |
|---|---|---|---|---|
| S | P0 + 单任务 plan | quick，可在用户要求时 full | light，可按需跳过知识增强 | off |
| M | 标准规划 + 分批实现 | 每批 quick，最终 full | standard | basic |
| L | 完整规划 + 多 Agent 串行 | 每批 quick，关键批 full，最终 full | full | full |

## S 级轻流程

S 级必须同时满足：

- 预计改动不超过 5 个文件，且其中业务逻辑文件不超过 3 个（测试、类型和同职责小工具可随主改动计入）。
- 不新增用户可见主流程入口。
- 不改跨模块公共接口、数据模型、权限、计费、发布、鉴权或批量操作。
- 有有效 `openspec/plan.md`，且本次请求能对应到单个任务。

满足时允许：

- 不调用多 Agent。
- `/feai-review` 默认 quick。
- `/feai-archive` 使用 light，只写必要变更记录和状态清理。
- **阶段门禁按 quick 降级**：S 级无需逐项对照四门禁全表，只核对与本次改动相关的关键项（对应 `global.md` G10 的 S 级降级）；不因流程强度对 S 级追加无关探索或全量测试。
- **计划粒度**：S 级只保留 1–3 条任务级 checkbox；TDD 子步骤和机械命令不计为 plan 任务。
- **风险驱动验证**：局部、低风险且依赖面未变化时，精确相关测试通过后可停止扩展；共享工具、状态/事件链、公共接口、构建配置、关键路径或影响范围不确定时，必须追加包级、集成或 P0 E2E 验证。不得为无关全量失败做破坏性的 checkout/stash 基线回放，但可使用现有 CI 或非破坏性证据判断是否为回归。

## M 级标准流程

M 级默认保留标准规划与分批 review，但不强制每批 full review。

- 每批最多 3 个任务。
- 每批 quick review。
- 最后一批或用户要求时 full review。
- archive 使用 standard，写知识沉淀与基础诊断。

### M 级上下文债务防护

- **防过度拆解**：单个 bug / 小需求不得展开成十几个任务；任务数应匹配真实工作量，能合并的相邻子任务合并。`plan.md` 是执行事实源，但不追求"任务越细越好"。
- **每轮只加载当前批次 active slice**：实现阶段默认读 `.workflow/runtime/current-task.summary.md`（当前批次 ≤ 3 任务），`plan.md` 仅按需加载校准，不每轮回灌完整 plan 历史（见 `context-recovery.md` / `context-budget.md`）。

## L 级完整流程

L 级保留完整可靠性：

- 允许 Leader 串行调度多 Agent。
- 关键批次和最终批次使用 full review。
- archive 使用 full，包含 metrics、localUsageAudit、flowHealth、ruleEffectiveness。

## 升级条件

任一条件命中时，提升一级流程强度：

- 连续失败 >= 2 次。
- 影响文件 > 5。
- 修改公共 API、权限、鉴权、发布、计费、数据迁移。
- 用户明确要求完整 review、完整 archive 或高可靠模式。
- Reviewer 初筛发现 P0/P1 风险。

## 模型路由（成本分层的模型维度）

所有 model id 使用 CodeBuddy 可识别 ID；项目可在 `.workflow/project.yaml` 的 `workflow.model_routing` 覆盖。

| 用途 | 默认模型 | 说明 |
|---|---|---|
| planning / developer / default | `glm-5.2-ioa` | 日常规划与实现 |
| review 初筛 / archive 摘要 / context doctor 解读 | `deepseek-v4-pro-ioa` | 低成本扫描、摘要、分类 |
| escalation / 高风险裁决 | `claude-opus-4.8-1m` | 架构、安全、发布、反复失败 |

路由规则：

1. 低风险读文档、摘要、初筛、指标分析优先低成本模型。
2. 业务实现和常规规划使用默认主模型。
3. 发现架构冲突、安全风险、发布风险或连续失败 >= 2 次时升级高阶模型。
4. 模型升级只传递压缩 handoff，不转发完整对话历史。
5. 工具不支持自动切换模型时，把推荐模型写入 handoff，等待用户或 Leader 切换。

角色建议：`default`/`leader`/`planner`/`developer`/`implementer` = `glm-5.2-ioa`；`reviewer-initial`/`archive` = `deepseek-v4-pro-ioa`；`escalation` = `claude-opus-4.8-1m`。

成本纪律：不让高阶模型做全量常规扫描；不让低成本模型做不可逆决策；每次升级模型必须说明触发条件。

## 阶段上下文隔离

- 决定隔离阶段且 CodeBuddy CLI 可用时，implementation / review / archive 使用 `handoff + phase run` 新 session；不使用 resume/continue。
- 独立阶段的 handoff 以 3,000 tokens、首轮模型输入以 30,000 tokens 作为健康目标，不是拒绝必要上下文的硬上限；超目标时优先改用文件引用和证据索引，禁止静默删除成功标准、风险或验证事实。
- S 级短任务且当前上下文健康时无需强制隔离；当阶段历史明显膨胀、跨阶段事实已稳定或需要独立 review 时再创建新 session。
- 主流程接收结构化阶段结果并保持精炼；长度不设固定质量上限，必须完整包含状态、改动文件、真实验证、风险、缺失上下文和下一步。

## 禁止

- 为省 token 跳过必要测试。
- 把 S 级轻流程用于高风险代码。
- 在 plan 为空或无有效任务时直接写业务代码。
