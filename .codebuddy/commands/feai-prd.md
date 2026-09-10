# /feai-prd — 创建 TAPD 需求单

读取并执行 feai-prd skill（`.codebuddy/skills/feai-prd/SKILL.md`），按其 6 步流程工作：
选模板 → 读字段配置 → AI 辅助填写（复杂度分层 + 影响评估）→ 选迭代 → 质量门禁 → 创建需求单。

用户参数照原样理解：`需求描述` 作为初始输入，`--workspace <id>` 覆盖本次 workspace，`--template <id>` 跳过模板选择。
创建成功后询问是否调用 `/feai-start {19 位完整 Story ID}` 进入研发。
