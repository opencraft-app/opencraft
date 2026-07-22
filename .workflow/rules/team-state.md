# 多人 / 多 Agent 状态边界

> 目标：多人或多 Agent 编码时，降低共享文件抢写、重复归档、并行实现互相覆盖的概率。本规则按需读取；命中多 Agent、多人同时开发、subagent、worktree、review、archive 时必须读取。

## TS1：默认串行，例外并行

同一工作区默认一次只允许一个写代码角色处于 active。允许并行的场景只有两类：

1. 只读调查、代码定位、方案比较，不写文件。
2. 写文件但使用独立 git worktree，且已声明互不重叠的文件归属。

不满足以上条件时，即使任务看起来无依赖，也必须串行。

## TS2：本地团队状态只进 runtime

多人协作状态写入 `.workflow/runtime/team-state.json`，该目录必须被 `.gitignore` 忽略。禁止把 active agent、临时锁、运行中批次、个人上下文缓存写入 tracked 文件。

推荐结构：

```json
{
  "active": [
    {
      "owner": "developer",
      "batch": "batch-2",
      "mode": "write",
      "worktree": ".",
      "files": ["src/foo.ts", "src/foo.test.ts"],
      "startedAt": "2026-01-01T00:00:00Z"
    }
  ],
  "handoff": {
    "from": "developer",
    "to": "reviewer",
    "files": ["src/foo.ts", "src/foo.test.ts"],
    "status": "ready_for_review"
  }
}
```

### 事实源分层

| 类型 | 文件 | Git 策略 |
|---|---|---|
| 当前需求执行依据 | `openspec/plan.md` | 版本管理，按任务批次更新 |
| 当前需求技术快照 | `openspec/proposal.md` / `openspec/spec.md` | 版本管理，规划与归档阶段更新 |
| 低频项目地图 | `openspec/current_state.md` | 版本管理，由 `/feai-init` 初始化/更新；`/feai-archive` 仅在稳定架构变化、模块边界变化或用户明确要求时更新 |
| 会话 / Agent 临时状态 | `.workflow/runtime/**` | 本地忽略，不入库 |
| 跨 Agent 交接摘要 | 对话 handoff 或 `.workflow/runtime/*handoff*.md` | 默认本地忽略；如需共享，转写到 plan 或归档 |
| 验证证据索引 | `.workflow/runtime/verification-ledger.md` | 本地忽略；归档时提炼摘要 |
| 历史沉淀 | `openspec/changes/*.md` | append-only 优先 |

`openspec/plan.md` 是当前需求执行唯一依据。runtime 摘要与 plan 冲突时，以 plan 为准并重新生成摘要。
runtime summary / handoff / verification ledger 的格式和预算见 `.workflow/rules/context-recovery.md`。

## TS3：共享状态文件单写者

以下文件容易冲突，必须单写者更新：

| 文件 | 默认 owner | 规则 |
|---|---|---|
| `openspec/plan.md` | Leader / default | 只更新任务状态和计划范围；Developer 不重写计划结构 |
| `openspec/proposal.md` / `openspec/spec.md` | Planner / archive | 实现阶段只读，除非 Leader 明确派发修订 |
| `openspec/current_state.md` | `/feai-init` / `/feai-archive` 按需 | 只记录低频项目地图；不写当前进行中需求、上一个需求摘要或历史归档清单，普通实现和 reviewer 不直接改 |
| `openspec/changes/**` | `/feai-archive` | 归档命令单写；reviewer 只提供摘要输入 |
| `.workflow/project.yaml` | `/feai-init` / 用户 | 不在开发批次中顺手修改 |
| lockfile / package manifest | 当前批次 owner | 多人同时改依赖前必须先合并计划 |

若必须多人同时改共享文件，先让 Leader 拆成明确顺序，后一个写入者基于前一个完成后的最新版本继续。

> 权威的高冲突路径清单以 `.workflow/project.yaml` 的 `shared_write_files` 为准；本表仅为这些路径补充默认 owner 与协作约束，新增/调整路径请先改 `project.yaml`。

## TS4：文件归属清单

Leader 派发写任务前必须给出归属清单：

```text
Owner: developer
Batch: batch-1
Allowed writes:
- src/foo.ts
- src/foo.test.ts
Read-only context:
- openspec/plan.md
- openspec/spec.md
Forbidden writes:
- openspec/current_state.md
- openspec/changes/**
- .workflow/project.yaml
Handoff target: reviewer
```

被派发者只能写 `Allowed writes`。发现需要修改清单外文件时，先停止并向 Leader 报告，不要自行扩大范围。

## TS5：Reviewer 默认只读

Reviewer 的默认职责是验证、补充测试建议、生成评审结论和知识沉淀输入。只有在归属清单明确授权时，Reviewer 才能写测试、文档或 E2E 文件。

Reviewer 不直接执行归档写入，不重置 `plan.md` / `proposal.md` / `spec.md`，不更新 `current_state.md`。归档统一交给 `/feai-archive` 或 Leader 触发的 archive 阶段。

`current_state.md` 不承载当前会话进度、当前分支、临时 checkpoint、agent 活跃状态、上一个需求摘要或历史归档清单；这些高频状态进入 `.workflow/runtime/` 或交接摘要，需求历史进入 `openspec/changes/*.md`。

## TS6：并行技能使用边界

`dispatching-parallel-agents`、`subagent-driven-development` 等并行技能只能用于：

- 只读调查。
- 独立 worktree 中的非重叠写任务。
- Leader 已写清文件归属、合并顺序和回收方式。

禁止多个 agent 在同一工作区并行修改业务代码、OpenSpec 产物、依赖清单或锁文件。

只读调查还必须遵守 `.workflow/rules/agent-dispatch.md`：

- 已有调查结论后的追问默认使用 Targeted Verification。
- 派发前先写 Investigation Brief，禁止把完整主会话历史交给子 agent。
- 以约 5 次工具调用、5 个候选文件作为初始成本检查点；证据不足时按 `agent-dispatch.md` 扩展调查或返回具体的 `NEEDS_CONTEXT`，不得把参考预算当作质量上限。
- 默认不读取 memory、`openspec/current_state.md`、`openspec/changes/**`，除非用户明确要求查历史。

## TS7：冲突处理

发现同一文件被多人修改、`git status` 出现未归属改动、计划文件与代码不一致时：

1. 停止继续写入。
2. 保留现场，列出冲突文件和当前 owner。
3. 由 Leader 决定串行合并、拆 worktree、或请用户决策。
4. 禁止自动 stash、自动 reset、自动覆盖他人改动。
