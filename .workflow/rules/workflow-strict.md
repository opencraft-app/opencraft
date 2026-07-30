# Strict Workflow Rules

> 严格流程细则。仅在执行 `/feai-*`、新需求开发、跨阶段流程、commit/push/MR/review/archive 或高风险编码时读取。

## 触发条件

- 执行 `/feai-start`、`/feai-review`、`/feai-archive`、`/feai-init` 等命令。
- 启动新需求，或用户要求实现但当前没有有效 plan。
- 当前请求无法确认是否落在 `openspec/plan.md` 范围内。
- 跨模块、高风险、用户可见行为的大范围改动。
- 创建分支、提交、push、创建 MR、review、archive。

## 前置步骤

1. 读取 P0-Min：`AGENTS.md`、`.workflow/rules/global.md` + 事实源（规划阶段 `openspec/plan.md`；实现阶段 `.workflow/runtime/current-task.summary.md` 的 active slice + 当前批次 ≤3 任务，`plan.md` 仅按需校准）。summary 缺失时从模板初始化，见 `context-recovery.md`。
2. 检查 `git status --porcelain`，识别未归属改动。
3. 需要 workflow mode、capability、gates、项目上下文时读取 `.workflow/project.yaml`。
4. 需要选择 review / archive / metrics 强度或模型分流时读取 `.workflow/rules/flow-cost.md`；**流程强度按 S/M/L 分级，小任务走轻流程**（G18）。
5. 确认 `openspec/plan.md` 有有效 `- [ ]` 任务。
6. 多 Agent 只使用 `.workflow/agents/` 中定义的角色，并保持串行交接。

## 每批与停机

- 每完成一批任务（`/feai-review` 结论后）刷新 `.workflow/runtime/current-task.summary.md` 的 Active Slice 与 Freshness（G27 / `context-recovery.md`）。
- 命中 G4 早停条件（含"无法本地复现且历史提交无明确复现路径"）立即停机询问或转诊断分支，不扩大搜索面。

## 验收确认点

所有计划任务完成且 verification gate 通过后，先输出验收摘要（变更、验证、风险、未处理项）并停下等待用户确认。用户明确确认前，禁止自动执行 `/feai-archive`、`git commit`、`git push`、创建 MR/CR 或关闭 plan。

## 进度沟通

- 文档中的阶段编号只描述流程结构，不要求运行时逐段播报。
- 连续读取、搜索、测试、lint、typecheck 和脚本调用应合并执行，不为每条命令生成独立模型消息。
- 预计耗时较长时可在开始时说明范围；持续超过 60 秒时再发送一次聚合进度。
- 低风险、可逆、规则可确定的决策自动处理，并在最终摘要记录。
- 会覆盖用户工作、扩大需求范围或产生外部影响的决策必须停下询问，但直接输出决策卡片，不添加 `[STEP N/M]`。
- 用户明确要求详细过程时，才按需输出阶段编号。

## 产物路径

| 阶段 | 产物 | 路径 |
|---|---|---|
| Planning | proposal | `openspec/proposal.md` |
| Planning | spec | `openspec/spec.md` |
| Planning / Implementation | plan | `openspec/plan.md` |
| Archive | change record | `openspec/changes/{YYYY-MM-DD}-{change-name}.md` |
| Long-term state | current state | `openspec/current_state.md` |

写到 `.codebuddy/plans/`、`docs/plans/` 或项目根的计划文件不满足门禁。

## 未归档变更

当 `openspec/changes/` 下存在开发期目录形态变更时，**非阻断强提醒**（G22）：先列出未归档变更清单与风险，请用户确认——可选择继续开始新需求，或先归档。不硬性禁止继续。

用户可回复继续，或回复 `SKIP-ARCHIVE` 显式跳过归档；含糊回复时再简短确认一次，不擅自替用户决定。
