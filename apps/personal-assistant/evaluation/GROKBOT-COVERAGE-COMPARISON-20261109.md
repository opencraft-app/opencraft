# Grokbot 参考实现与覆盖损失的归属

2026-11-09。本轮对照本机会话目录的 `grokbot-reference-a9f633e`，其身份由现有对照记录固定为非官方恢复/扩展代码 `a9f633e09d49a85829b8236331b9e21f7e612634`。本轮直接读取具体文件并记录哈希，不宣称验证了官方线上当前行为，也未执行原版真实模型评测。旧对照文档中的 `<operator-local-reference>` 路径当前不可用，本地副本可读。

## 能从代码确认的共同限制

- memory-synthesis-service.ts 的 verificationSystemPrompt 只要求 approved 布尔值，且要求每项都合格。runAgent 在 false 时抛 rejected，外层 retry 重新执行完整 perform，最多三次；最后失败会消费本批待处理证据。没有逐项通过结果，也没有向下一次提议反馈拒绝理由。因此整批否决和无反馈重试是参考设计本身的风险，我们继承了它。
- synthesisSystemPrompt 要求保持紧凑、连贯、演变后的状态，而非积累逐字历史，允许 update/remove 取代过时事实。memory-service.ts 的 update 移除旧事实再写新事实，没有强制产生偏好转变的完整事件链。因此不保证回答整个偏好演变也是共同限制；并非证明它绝对不能将变化写在 log 或事实正文中。
- 两者都有 12 轮输入合并、每次尝试 90 秒和有限重试。本轮我们没有发生输入截断，不能用这些共同上限解释实际 5/7 批次否决。

## 我们的偏差和缺口

进一步核对见[模型契约审查](MEMORY-MODEL-CONTRACT-REVIEW-20261109.md)：我们已有 memory.file.read，不能将差距简化成“我们只提供 SQL、参考才有文件读取”；参考 grep 也不等于语义搜索。

- **模型不同**：参考 production.ts 将提炼、复核都绑定 SAND_SUMMARIZATION_MODEL_ID；该固定副本常量为 gemini-2.5-flash。我们的本轮是 hy4 / none，经 Codex Responses；过去是 DeepSeek。没有官方服务或原模型行为的对照，不把相同控制流程当作相同拒绝率和质量。
- **提示词不是逐字复刻**：我们重新表述了提炼与复核指令，并增加 scope、项目、用户证据等约束。原版输入分别为 currentMemories/newEvidence 或 currentMemories/evidence/proposedChanges；我们发送 evidence/snapshot/proposal，snapshot 还包含重复的 facts/memories 和授权元数据。来源也由每 exchange 的 user+assistant 对改成独立角色消息与用户消息 ID。这些语义/载荷差异可能影响提议与复核，未做消融，不能认定其影响方向。
- **检索接口不同**：原参考为文件记忆，并在上下文引导通过 Read/Shell grep 读取更多文件；我们独立提供 memory.search，当前为连续子串 SQL。不能将我们的自然语言关键词查询漏召回归因于参考版也用这个 SQL。当前 memory-only 评测主动限制原文/工具能力，是组件协议，不代表完整助理与完整 Grokbot 等价。
- **错误分类有差距**：参考显式区分 invalid-output/rejected/stale/failed 并报告粗粒度 outcome；我们最终 rejected 会清除 error，观测还不能重建全部中间提议。两者都缺逐候选语义拒绝理由，但不能说参考连失败类别也没有。
- **恢复有意不同**：我们持久保存提议并在传输失败后从复核恢复，参考每次重走提炼。该差异有恢复价值；本轮全模型调用 returned，不能用它解释本轮语义否决。

## 应如何下结论

机制测试说明控制流程和保护契约已接通，不能证明模型质量与参考相同。当前能确认结构性风险源于参考；不能确认我们测得的高拒绝率就是原版水平，也不能只凭高拒绝率认定是复刻错误。

下一步应先做固定模型、固定证据、固定截止与随机策略的保真对照：对齐参考提示词及最小模型输入，保留同一宿主来源/权限/CAS校验，采用适配后的相同证据身份，避免原 parser 的 ID 长度差异成为无关失败。分别记录提炼、复核与提交成功及事实质量；若需定位原因，再将提示词、载荷作为分开的变量。已知历史只作回归，另外保留未见历史验证。

对照后再决定是否改整批复核。逐项理由/独立事实单元是明确的产品改进方向，但在尚未量化复刻偏差前就重做机制，会混淆“补齐复刻”与“改进原设计”。
