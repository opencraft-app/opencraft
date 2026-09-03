# ADR 0002：设计历史恢复与 docs-impact 持续治理

- 状态：已采纳
- 日期：2026-09-01
- Owner：`wisp/mono2-maintainers`
- 范围：mono2 的跨服务正式设计、任务级 Context 与变更评审

## 背景

代码、提交、MR、TAPD/Issue 和设计文档往往分散保存。只让 Agent 在每次需求中全量扫描历史，既消耗 Token，也容易把已退出的方案误认为当前约束；反过来把全部历史复制进默认 Context，也会造成同样的问题。

现有 V1 文档体系已区分正式工程知识、派生 Context 和评测层，但缺少两个闭环：如何有界恢复一个功能的演进历史，以及代码变更如何提醒贡献者同步当前设计真源。

## 决策

### 1. 按功能演进族保存“当前入口 + 有界回退”

`.agents/context/design-history-index.json` 是机器可读索引，不保存完整历史正文。它登记：

- 需求来源母集的可访问状态；Git、MR、TAPD/Issue 无法读取时必须写 `unknown` 或 `unavailable`；
- 功能族的当前设计记录、当前代码证据、派生 Context 和 Owner；
- `current`、`superseded`、`retired`、`historical`、`unknown` 五态，以及替代关系；
- 每个任务真实读取的历史来源和无法确认的边界。

恢复一个需求时，Agent 先用受影响路径、需求标识和功能族确定范围，再读取首次引入、关键变更和当前实现的 Git 证据；若平台权限允许，再以同一标识查询 MR、TAPD 或 Issue。它要把事实、推断、未知分开写入 Task Pack，不以提交次数推断 Owner，也不编造外部系统中的设计意图。

默认路由只加载当前设计与短 Context。`superseded`、`retired` 和 `historical` 记录只在命中具体需求时有界读取；`unknown` 不能作为实现依据。

### 2. 用 docs-impact 约束“代码变更—当前设计真源”

`.agents/context/change-impact.json` 将高风险路径映射到相关正式 Domain、Journey、架构或 ADR。`validate_change_impact.py` 对变更清单做确定性检查：命中规则的代码或控制面改动，必须同时修改至少一份该规则的正式设计文档；否则本地 pre-commit 与已注册的 MR guard 失败。

这不是用脚本替代语义评审。脚本只能证明“映射的设计文档与代码同一变更集出现”，不能证明文档内容已经正确解释所有行为变化。任务实施仍须由 Agent 依据 Task Pack、源码和历史证据决定影响；高风险变更应由仓库平台把对应 Owner 加入 MR 审阅。当前仓库没有受保护 MR 审批回执 adapter，因此该平台级 Owner 确认仍标为待接入，不能伪称已自动完成。

## 初始范围与已知边界

初始索引覆盖五个现有 Domain 和 Context Engineering 本身的当前入口。它不是对 mono2 全部历史需求的一次性穷举：未建立可靠外部来源母集的功能保持 `unknown`，在其首次受影响任务中按上述流程恢复。这样避免批量制造“看似完整、实际无来源”的历史文档。

评测 Gold、模型答案、逐样本结果、评分、回执和日志仍完全留在 `docs/context/evaluation/` 的运行时禁入边界之外；它们不得作为设计历史或 docs-impact 的输入。

## 后果

- 后续 Agent 不需要为每个任务扫描全仓提交史：先读取当前设计入口，再对命中的功能族做有界历史检索。
- 代码与正式设计会在本地与 MR 变更集上被显式关联；但映射规则需要 Owner 定期复查，不能成为新的平行真相。
- 新增目录或文档不是完成条件。每条索引记录必须有当前来源、Owner、生命周期和验证入口；没有证据的内容保持未知。

## 验证与复查

```bash
python3 .agents/context/scripts/validate_change_impact.py --repo . --staged
python3 .agents/context/scripts/validate_context.py --repo . --build-catalog
```

当服务边界、正式设计入口、仓库平台的 MR 审阅能力或外部来源访问权限变化时，更新 `change-impact.json`、`design-history-index.json` 和本 ADR。
