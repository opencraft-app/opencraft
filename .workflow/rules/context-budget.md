# Context Budget Rules

> 按需读取。本文件约束 AGENTS.md、P0 和长上下文的边界，目标是让默认上下文有用但不过载。

## 原则

1. P0 只放影响安全、执行依据或当前任务边界的最小文件。
2. AGENTS.md 必须人工维护为薄入口，只写硬纪律和索引，不写仓库 overview。
3. 能通过 `rg`、文件树、`package.json`、`.workflow/project.yaml` 查到的信息，不复制进 P0。
4. 新增规则优先替换、拆分或索引，避免扩写入口文件。
5. 自动生成的大段上下文只能作为草稿，进入 P0 前必须人工裁剪。

## P0-Min

固定入口（所有阶段默认读取）：

1. `AGENTS.md`
2. `.workflow/rules/global.md`

当前需求事实源，按阶段二选一默认读取：

- **规划阶段**：`openspec/plan.md`（生成/校准执行计划）。
- **实现阶段**：`.workflow/runtime/current-task.summary.md`（默认必读的 active slice + 当前批次 ≤ 3 任务）；
  `openspec/plan.md` **仅按需加载**用于校准，不每轮回灌完整 plan 历史。

`openspec/plan.md` 是执行事实源；`AGENTS.md`/`global.md` 只约束 agent 行为，不替代 plan。
`current-task.summary.md` 是恢复缓存：缺失时按 `.workflow/rules/context-recovery.md` 从模板初始化，
每批完成后刷新，必须校验 `planHash`；**范围裁决始终以 plan.md 为准**，summary 不得替代 plan 裁决。

## 预算分层

`2,500 tokens` 是 P0 健康目标，不是硬阻断线。不要为了几十到几百 token 牺牲入口文件可读性；优先治理误读 P1/P2、长终端输出、重复 spec/current_state。

| 项 | target | warn | fail |
|---|---:|---:|---:|
| P0 总量 | 2,500 | 3,200 | 6,000 |
| 固定入口：`AGENTS.md` + `global.md` | 2,000 | 2,400 | 3,200 |
| `AGENTS.md` | 700 | 900 | 1,200 |
| `.workflow/rules/global.md` | 1,300 | 1,600 | 2,000 |
| 默认读取文件数 | 3 | 4 | 6 |
| 单个核心按需规则文件 | 800 | 1,200 | 2,000 |
| capability / 项目扩展规则文件 | 4,500 | 6,000 | 8,000 |
| workflow / capability checklist | 2,500 | 3,500 | 5,000 |

核心规则按工具内置的稳定文件名集合识别；`.workflow/rules/` 中其余 Markdown 文件属于 extension。旧项目显式配置的 `on_demand_rule` 会继续继承到 extension，并可用 `extension_rule` 单独覆盖。Context Doctor 同时检查 checklist、各框架最终规则，以及默认 AGENTS 追加单个或全部 capability section 后的组装大小。

`openspec/plan.md` 按任务规模单独看：

| 规模 | target | warn | fail |
|---|---:|---:|---:|
| S | 500 | 800 | 1,500 |
| M | 1,000 | 1,500 | 2,500 |
| L | 1,500 | 2,500 | 4,000 |

任务数量预算：S 级 1–3 条、M 级建议不超过 8 条；checkbox 只表示可验收任务，不表示读取、RED/GREEN、命令执行或提交步骤。

处理策略：

- `target` 内：健康，不需要压缩。
- 超过 `target` 但未到 `warn`：只在顺手维护时优化，不专门压缩。
- 超过 `warn`：输出可解释 WARN，优先拆 plan、摘要长段落、减少默认读取。
- 超过 `fail`：阻断严格流程启动，先做 compact / summary / plan 拆分。

## 按需读取

| 场景 | 读取 |
|---|---|
| 需要 workflow mode / gates / capability / 项目上下文 | `.workflow/project.yaml` |
| 需要严格流程细节 | `.workflow/rules/workflow-strict.md` |
| 需要 S/M/L 流程强度、模型分流或降本裁决 | `.workflow/rules/flow-cost.md` |
| 需要只读调查 / sub-agent 派发 / 追问反证 | `.workflow/rules/agent-dispatch.md` |
| 需要长会话恢复 / handoff / 验证证据 ledger | `.workflow/rules/context-recovery.md` |
| 需要长终端输出压缩 | `.workflow/rules/terminal-output.md`、`commands/feai-terminal-output.md` |
| 需要诊断、timeline、token usage 约束 | `.workflow/rules/workflow-reporting.md` |
| 需要低频项目地图 / 稳定架构索引 | `openspec/current_state.md`（不记录需求历史或当前进行中需求） |
| 需要业务规格 | `openspec/specs/**/*.md` |
| 需要阶段门禁 | `.workflow/checklists/gate-*.md` |
| 需要角色职责 | `.workflow/agents/*.md` |
| 需要命令细节 | `commands/feai-*.md` |
| 需要团队动作 | `.codebuddy/skills/team-extensions/*.md` |
| Codex 技能入口 | `.agents/skills/*/SKILL.md` |

## 反模式

- 把 README、目录树、技术栈说明复制到 AGENTS.md。
- 同一规则在 AGENTS.md、global.md、project.yaml 三处重复维护。
- 为了防遗漏默认读取所有规则、spec、changes 或历史归档。
- 把建议写成硬门禁，导致 agent 做额外探索和无关测试。
- 调查型 agent 默认继承 memory、current_state、changes 或主会话完整历史。
- runtime summary 与 plan hash 不一致时继续按 summary 执行。
- 长终端输出直接进入对话上下文；需要治理时按 terminal-output 规则处理。
- 所有阶段都用最高规格流程和最高阶模型。
