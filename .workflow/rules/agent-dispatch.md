# Agent Dispatch Rules

> 按需读取。命中 Agent 工具、sub-agent、只读调查、代码定位、方案反证、review
> 返工或多轮追问时必须读取。本文件约束调查型 agent 的上下文输入与轮次预算，避免
> 已有结论后的追问被重新当作完整调查执行。

## AD1：调查分两类

| 类型 | 触发 | 目标 |
|---|---|---|
| Full Investigation | 新 bug / 新模块 / 完全未知调用链 | 建立第一版根因判断 |
| Targeted Verification | 已有调查结论后的追问、反证、方案验证 | 验证一个具体未决问题 |

**默认优先 Targeted Verification**：已有结论后的追问、反证、方案验证优先验证具体未决问题。发现问题边界扩大到新 bug、新模块、原结论被证伪或现有证据无法支撑可靠结论时（见 AD6），直接升级为 Full Investigation，并在结果中记录原因；不得为了节省 token 维持错误的窄范围。

**无法复现时保留证据边界**：先完成安全且相关的静态分析、环境差异检查和现有测试验证；仍缺少复现所必需的外部日志、数据或环境时，再返回已知结论并触发 Stop-and-Ask（对应 `global.md` G4）。不得把“尚未复现”误写成“问题不存在”。

## AD2：Investigation Brief

每次 Full Investigation 结束后，主 agent 必须保留一段轻量 brief，后续追问只引用 brief，
不得滚入完整调查过程。

```text
Investigation Brief
- 已知结论:
- 证据:
  - path:line — 关键事实
- 未决问题:
- 已排除方案:
- 下一步验证点:
```

brief 只保留结论、证据和未决问题，不复制工具输出全文、完整 diff、长日志或历史归档。

Full Investigation 使用弹性预算：可先以约 8 次工具调用、8 个候选文件作为成本检查点，但这不是质量上限。到达检查点时评估根因证据、反证、依赖影响和验证覆盖；证据充分则返回 brief，证据不足或出现跨模块/高风险线索则继续调查并记录扩展原因。不得为了补齐无关“完整画像”扫描历史 memory 或已排除分支，也不得为了满足预算提前宣告根因。

## AD3：Targeted Verification Prompt

派发定向验证 agent 时，prompt 必须包含以下字段：

```text
任务类型: Targeted Verification
已知结论: <来自 Investigation Brief 的 1-3 条>
待验证问题: <只允许一个问题>
允许读取:
- 候选文件或目录
- 搜索关键词
禁止读取:
- memory / MEMORY.md
- openspec/current_state.md
- openspec/changes/**
- 与待验证问题无关的历史归档
成本检查点:
- 初始工具调用参考: 5
- 初始候选文件参考: 5
- 返回摘要: 精炼但证据完整
返回格式:
- 结论:
- 证据:
- 风险/不确定:
- 下一步:
```

到达成本检查点仍不能确认时：如果缺的是父级掌握的需求、日志、环境或候选范围，返回 `NEEDS_CONTEXT` 并具体说明；如果必要证据可在当前仓库安全获取，则继续定向调查。`NEEDS_CONTEXT` 用于请求缺失事实，不用于机械终止调查。

## AD4：只读调查的默认禁止项

调查型 agent 默认不得读取或依赖：

- CodeBuddy / IDE 自动注入的 memory 全文。
- `openspec/current_state.md`。
- `openspec/changes/**` 历史归档。
- 主会话完整聊天历史。

例外：用户明确问“历史上怎么处理”“参考之前经验”“查归档/记忆”时，可以读取对应历史文件，
但必须在返回中说明读取原因。

## AD5：主会话职责

主 agent / Leader 必须做上下文裁剪：

1. 先把已有结论压缩成 Investigation Brief。
2. 再决定是否需要派发 Targeted Verification。
3. 只传 brief、待验证问题、候选文件/关键词和预算。
4. 收到返回后，只把结构化结论并入 brief，不把完整过程继续滚入后续上下文。

## AD6：升级条件

满足任一条件时，允许从 Targeted Verification 升级为 Full Investigation：

- 待验证问题被证伪，原根因不成立。
- 发现新的独立 bug 或新的业务链路。
- 需要跨模块重新建模，或候选范围明显超出定向验证的初始假设。
- 用户明确要求完整复盘或完整调查。

升级属于只读、范围内调查时无需暂停等待用户确认，但必须在阶段结果中说明原因和新增证据范围；只有扩大需求范围或需要外部影响动作时才 Stop-and-Ask。

## AD7：反模式

- 把“已有结论后的追问”重新交给通用 file-search agent 全量调查。
- 让子 agent 自己读取 plan、memory、current_state、changes 后再决定要做什么。
- 多个连续追问都携带前一次完整工具输出。
- 为了“更稳”无限追加搜索关键词和文件读取。
- 返回“我继续查一下”式过程汇报，而不是结论和证据。
- 已经形成根因链后仍连续搜索十余轮，只为把低概率假设全部排完。
