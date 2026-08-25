# 全局工作流规则

> P0 核心规则。只保留所有 Agent 必须立即遵守的硬边界；长流程、示例、用量审计细则按需读取同目录规则文件。

## G1：先确认事实源

新需求、跨阶段流程或高风险编码前，必须先确认 `openspec/plan.md`。普通问答、代码解释、状态确认、diff 分析可按需读取相关文件。

## G2：OpenSpec 是执行事实源

正式开发以 `openspec/plan.md` 为唯一执行依据。请求超出当前 plan，必须先回到规划流程。轻量补充仅限当前 plan 范围内的小修、小测、小文档，且不涉及高风险行为。

## G3：plan.md 门禁

进入实现前，`openspec/plan.md` 必须存在有效 `- [ ]` 任务。空文件、占位语或无任务列表时，禁止写业务代码。

## G4：Stop-and-Ask

命中任一即停止猜测，向用户说明事实、证据、可能原因和 2-3 个方案：重复同一失败假设且没有新证据；需求边界漂移；文档与代码冲突；发现未记录边界条件；或完成安全的静态分析、环境差异检查和现有验证后，仍因缺少外部日志/数据/环境而无法复现。可在仓库内取得的新证据应继续调查，不得用固定次数提前终止。

## G5：P0 加载

默认只读 P0-Min：`AGENTS.md`、`.workflow/rules/global.md` + 事实源——规划阶段读 `openspec/plan.md`，实现阶段读 `.workflow/runtime/current-task.summary.md`（active slice + 当前批次 ≤3 任务），plan 仅按需校准。其余按需读取，预算见 `.workflow/rules/context-budget.md`。

## G6：中文沟通

所有对话、状态汇报和风险说明使用中文。

## G8：分支与未提交改动

新需求禁止直接在 `master` / `main` 开发。切分支前必须检查 `git status --porcelain`；存在未提交内容时，禁止自动 stash、自动 commit 或强切，必须先让用户决定。

## G9：配置按需读取

严格流程需要 workflow mode、质量门禁、capability、项目上下文或依赖插件时读取 `.workflow/project.yaml`。普通问答不因本条强制加载大配置。

## G10：阶段门禁

Planning、Implementation、Verification、Archive 完成后对照 `.workflow/checklists/gate-*.md`，结论只能是：通过、打回、有条件通过。S 级可按 `flow-cost.md` 降级为 quick，只核对与本次改动相关的关键项，不逐项跑全表。

## G11：角色不越权

多 Agent 模式只使用 `.workflow/agents/` 中定义的角色。Leader 负责调度与审核，禁止直接实现业务代码（inline 委托形状除外，见 `.workflow/rules/flow-cost.md` 委托形状段）；各角色必须串行交接。多人 / 并行边界见 `.workflow/rules/team-state.md`。

## G12：Skill 调用真实发生

严格流程中标注必须调用的 skill 必须真实调用，不得口头声明、跳过调用或用自身知识替代 skill 输出。

## G13：失败回退

实现或测试连续失败时先保留现场、调用对应调试 skill、记录根因；不要在同一方向上无限重试。需要破坏性回退前必须说明影响并等待确认。

## G14：提交与沟通规范

实现与验证完成后先输出验收摘要并等待用户确认；确认前禁止自动 commit、push、MR/CR 或最终归档。用户明确说“提交/归档/push/创建 MR”后才进入对应流程。

提交、MR、CR 相关文案按 `.workflow/rules/quality.md` 与 `ai-usage-tracking` skill 执行。沟通保持简明透明，需要用户决策时提供 2-3 个可行方案。

commit message 优先遵循项目自身的提交规范（`commit-msg` hook / `CONTRIBUTING.md` / `commitlint` 配置等定义的格式）；项目无明确规范时，默认使用 Conventional Commits 格式（`type(scope): [FE-AI] 简要描述`，type 限 feat / fix / docs / style / refactor / test / chore / perf / build / ci），描述语言跟随项目惯例。禁止用 feai 默认格式覆盖项目已有规范。

## G15：外部系统边界

TAPD、工蜂、CI、发布等外部系统动作只在配置齐全且用户意图明确时执行；缺少配置或权限时停止并说明，不得伪造完成状态。

## G16：插件依赖

按需/懒校验：真正要用到 `.workflow/project.yaml` 声明的插件或 skill 时才确认可用，缺失时提示安装、不静默降级；不在流程启动前对用不到的插件预先硬阻断。

## G17：Leader 禁止直写代码

多 Agent / L 级需求中，Leader 只负责调度、审核和决策收敛；禁止直接创建或修改组件、hooks、页面、样式等业务代码。inline 委托形状（探索型 / 需中途交互 / S 级短任务）除外，见 `.workflow/rules/flow-cost.md` 委托形状段。

## G18：严格流程启动拦截

触发 `/feai-*` 命令、新需求开发、跨模块/高风险编码、commit/push/MR/review/archive 时进入严格流程：读 P0、确认事实源、检查分支和未提交改动、按门禁推进。**流程强度按 `flow-cost.md` 的 S/M/L 分级**——小任务走轻流程，不一刀切套用最重流程。详细步骤见 `.workflow/rules/workflow-strict.md`。

## G19：禁止工具替代工作流

禁止使用 IDE 内置 plan mode 替代 OpenSpec。规划产物只允许写入 `openspec/`，不得写入 `.codebuddy/plans/`、`docs/plans/` 或项目根临时计划文件。

## G20：进度沟通

连续机械步骤聚合执行；仅在耗时进度、阻塞决策和最终结果时沟通，决策卡片不加步骤前缀。

## G21：产物路径

proposal、spec、plan、changes 等工作流产物必须写入 `openspec/` 约定路径。路径细则见 `.workflow/rules/workflow-strict.md`。

## G22：未归档变更提醒

存在未归档开发期变更时，先以**非阻断强提醒**列出未归档清单与风险，请用户确认继续或先归档；不硬性禁止开始新需求。用户可回复继续或 `SKIP-ARCHIVE`。细则见 `.workflow/rules/workflow-strict.md`。

## G23：用量审计

`/feai-*` 命令的 usage-context（session id + provider）按 `.workflow/rules/workflow-reporting.md` 执行，供 `/feai-archive` 做需求级 localUsageAudit。provider 未确认会阻断，确认后的写入失败才不阻塞主流程。

## G24：规则分层

本文件必须保持短小。新增长示例、命令片段、JSON 细则、历史解释时，写入 P1/P2 规则文件，并在本文件只保留一句索引。

## G25：成本分层

S/M/L 强度与模型分流按 `flow-cost.md`，长输出治理按 `terminal-output.md`。

## G26：增量调查轻量化

已有调查结论后的追问默认按 Targeted Verification 执行：先沉淀 Investigation Brief，再只传单个待验证问题、候选文件/关键词和预算。只读调查 / sub-agent 派发细则见 `.workflow/rules/agent-dispatch.md`。

## G27：恢复缓存不替代事实源

长会话 summary、handoff 和 verification ledger 只写入 `.workflow/runtime/`，按 `.workflow/rules/context-recovery.md` 使用。它们不得替代 `openspec/plan.md`、门禁或真实验证命令。
