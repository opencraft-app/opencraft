# Context Recovery Rules

> 本规则细则按需读取；但其约束的 `.workflow/runtime/current-task.summary.md` 是**实现阶段 P0-Min 默认必读**
> 的 active slice 恢复缓存（见 `context-budget.md`）。命中长会话压缩、新会话恢复、多 Agent 交接、批次验证证据整理时读本文件。
> 本文件约束 `.workflow/runtime/` 下的本地恢复缓存。它们只帮助减少上下文，不替代
> `openspec/plan.md`、门禁或真实测试命令。

## CR1：事实源优先级

`openspec/plan.md` 是当前需求执行唯一依据。runtime summary、handoff、verification ledger
只能作为恢复缓存或证据索引；与 plan 冲突时，必须以 plan 为准并重新生成缓存。

## CR2：Current Task Summary（默认必读 active slice）

`.workflow/runtime/current-task.summary.md` 是**实现阶段默认必读**的恢复缓存（见 `context-budget.md` P0-Min），
不再是"超 warn 线才生成"的条件产物。它让实现阶段默认只读 active slice + 当前批次任务，而不是每轮回灌完整 `plan.md` 历史。

生命周期（固定协议，非主观判断）：

- **初始化**：文件缺失时，单向 `cp .workflow/runtime/current-task.summary.template.md .workflow/runtime/current-task.summary.md` 生成，再填 active slice。
- **每批刷新**：inline quick 通过后调用 `feai workflow batch complete`，统一刷新 plan、summary 与 ledger。
- **规划产出后**：`/feai-start` 计划确认后写入首个 active slice（当前批次 ≤ 3 任务）。

推荐结构见 `current-task.summary.template.md`（Freshness: branch/planHash/updatedAt/status + Active Slice）。

约束：

- `planHash` 使用当前 `openspec/plan.md` 原始内容的 SHA-256 十六进制值；记录时可写纯 hex 或 `sha256:<hex>`。
- 只保留 active slice 与当前批次 ≤ 3 任务，不复制完整 plan、完整日志或历史归档。
- 默认目标 `<= 1500 tokens`。
- summary 缺失、hash 不一致、branch 不一致或 status 不匹配时，读取完整 `plan.md` 校准后刷新；**范围裁决始终以 plan.md 为准**，summary 只做恢复缓存。

## CR3：Agent Handoff

跨 Agent、跨会话或长会话压缩恢复时，使用结构化 handoff，不传完整聊天历史。

```md
## Agent Handoff

- From:
- To:
- Requirement:
- Current stage:
- Branch:
- Platform scope:
- Completed:
- Changed files:
- Key decisions:
- Implementation deviations:
- Tests run:
- Known failures:
- Risks:
- Worktree status:
- Next action:
- Required context:
- Do not modify:
```

handoff 默认写入 `.workflow/runtime/*handoff*.md` 或直接发给下游 agent；如需团队共享，
必须把稳定事实转写到 `openspec/plan.md` 或归档文件，而不是提交 runtime 文件。

## CR4：Verification Ledger

每批验证后用 `.workflow/runtime/verification-ledger.md` 记录已验证证据，避免把“计划要跑”
误记为“已经跑”。

```md
## Verification Ledger

| 时间 | 命令 | 范围 | 结果 | 失败摘要 | 是否新增 | 结论 |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |
```

约束：

- 只记录真实执行过的命令或明确跳过原因。
- 失败必须标明是否新增；历史失败不能当作本次回归。
- 归档时从 ledger 提炼证据摘要，不把长终端输出复制进归档。

## CR5：禁止项

- 用 runtime summary 替代 plan 做范围裁决。
- 把 `.workflow/runtime/**` 提交入库。
- 在 `openspec/current_state.md` 记录当前会话进度、当前分支或 agent 临时状态。
- 把完整工具输出、完整聊天历史或完整日志写入 summary / handoff / ledger。

## CR6：阶段上下文隔离（CodeBuddy CLI）

CodeBuddy CLI 可用且当前上下文已明显膨胀、跨阶段事实稳定或需要独立 review 时，planning → implementation → review → archive 可使用新进程、新 session 执行重型阶段，避免主会话历史持续回灌。S 级短任务和上下文健康的阶段不强制切断：

```bash
feai workflow handoff write --from <from> --to <to> --spec-ready --apply --json # 进入 implementation 时
feai workflow handoff validate --phase <to> --json
feai workflow phase run --phase <to> --execute --json
```

约束：

- `phase run` 禁止使用 CodeBuddy 的 `--resume` / `--continue`，必须创建全新 session。
- handoff 必须先通过 branch、planHash、worktree fingerprint、非空计划和目标阶段自检；8KB 为健康目标，10KB 为模型可见硬上限。超长事实完整保留在 runtime 文件中，handoff 只带有界预览、hash 和 `loadPolicy=on_demand` 引用。
- 新阶段把 handoff 作为事实索引，读取 P0-Min、引用文件及保证正确性所需的代码、规则、技能和测试。memory、历史 changes 默认不读；任务明确依赖历史决策且当前证据不足时可按需读取并说明原因。
- handoff 必须保留目标、成功标准、范围/非目标、关键决策、风险、计划、验证要求和可校验引用；预览被裁剪时必须写入 `contextTruncations`，不得静默丢失来源。缺失必要事实时子阶段返回 `status=needs_context` 和 `requiredContext`，由主流程补充 handoff 后重试，禁止猜测。
- 子阶段不得自行启动下一阶段；返回 `phase-result.<phase>.json` 后由主流程决定是否继续。
- `phase run` 使用 `--append-system-prompt` 保留默认能力；review 禁用 Agent/Task 工具、主进程与子进程均用 plan 权限，并在执行后校验工作区指纹未变化。
- phase 原始输出完整落盘；返回主流程的结构化结果设总字节硬上限。最终 review 必须返回 `verdict`，并把 branch、planHash、worktree fingerprint 写入 `phase-result.review.json`，供 archive preflight 校验新鲜度。
- implementation 仅接受带 `--spec-ready` 的 handoff；该标记表示 `flow-cost.md` readiness checklist 已逐项确认。
- 实现方案发生变化时用 `feai workflow deviation add` 记录结构化偏差，归档直接消费，不把偏差过程回灌到后续会话。
- CodeBuddy CLI 不可用时只做同会话软恢复，并明确标记 `contextIsolation=soft`；不得宣称已降低 provider 输入上下文。
