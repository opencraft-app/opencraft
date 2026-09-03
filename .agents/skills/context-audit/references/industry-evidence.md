# 行业证据与适用边界

本标准不是声称所有领先公司使用同一目录名，而是把多家公开实践中反复出现的原则组合成可执行仓库契约：短而分层的指令、按需 Context、明确工具边界、软件目录/Owner、docs-as-code、架构层级、ADR、可复用 Skill 和评测隔离。

所有链接在 2026-08-31 做过可访问性检查。公开材料支持原则，不直接证明某个仓库采用本 Skill 后必然提高准确率。

| 公开来源 | 可依靠的共识 | 对本标准的落点 | 不能外推什么 |
|---|---|---|---|
| Anthropic, [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Context 是有限资源，应选择最小高信号集合；长期任务需要压缩、外部记忆和结构化管理 | 规则 1、3、5–9、17–19；短入口、按需路由、Checkpoint、Receipt | 不能证明固定 8/16 KiB 阈值适合所有模型；阈值是本标准的可操作默认值 |
| Anthropic, [Building effective agents](https://www.anthropic.com/research/building-effective-agents) | 从简单、可组合工作流开始；工具边界和可验证反馈比不必要复杂度更重要 | 规则 16、20、22；少而精工具、失败回流、三轮渐进建设 | 不能证明任何单一 Agent 架构在所有任务最优 |
| CodeBuddy IDE, [4.11.3 发布说明](https://www.codebuddy.cn/docs/ide/release-notes/release-notes#_4-11-3-2026-08-28) | 主流 Coding Agent 产品持续优化长对话的上下文压缩策略，说明窗口压力与压缩治理是实际产品问题 | 作为规则 5 的补充产品实践信号；具体实现仍由目标 Harness 的文件、测试与运行证据确认 | 公告只有一句概述，仅能支持“产品采用压缩治理”这一层事实；具体阈值、清理策略和效果仍需公开、可复核的独立证据 |
| OpenAI Codex, [AGENTS.md guide](https://developers.openai.com/codex/guides/agents-md) | 仓库与子目录指令可分层发现，越接近目标文件的规则越具体 | 根/局部 `AGENTS.md`、规则 1–2、服务级增量入口 | 不规定本标准的文档分类、Catalog 或分值 |
| Agent Skills, [Specification](https://agentskills.io/specification) | Skill 使用带 `name/description` 的入口，并通过资源渐进加载可复用工作流 | `.agents/skills/<skill>/SKILL.md`、references/scripts/tests | Skill 元数据合法不代表工作流在目标仓库有效 |
| GitHub Copilot, [Repository custom instructions](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot) | 仓库级和路径级指令应简短、明确并与目标路径相关 | 根入口、路径级局部规则、避免百科式指令 | 不证明 GitHub 的加载细节等同于其他 Agent Harness |
| Backstage, [System model / Software Catalog](https://backstage.io/docs/features/software-catalog/system-model/) | Component、System、Domain、Owner 和关系适合用机器可读 Catalog 管理 | Service Catalog、Domain、owner、上游/下游和 docs 入口 | 不要求必须部署 Backstage；可用等价 Catalog 实现 |
| Diátaxis, [Documentation framework](https://diataxis.fr/) | 教程、How-to、Reference、Explanation 服务不同读者任务，文档应按用途分离 | 正式文档分类、Runbook/Reference/Architecture 职责分离 | 本标准没有机械照搬四象限；服务/Domain/Journey 是仓库工程补充 |
| C4 Model, [C4 model](https://c4model.com/) | 架构描述应有清晰层级与不同缩放尺度 | system overview、service topology、服务局部 architecture | C4 图存在不等于系统事实最新；仍需 owner 和复查 |
| ADR community, [Architectural Decision Records](https://adr.github.io/) | 重要架构决策应记录背景、决定与后果，并留在版本控制中 | `docs/engineering/decisions/ADR-*` 与服务局部 ADR | ADR 是历史决策记录，不替代运行手册和当前配置 |

## 证据链使用规则

1. 行业来源解释“为什么这个原则合理”。
2. 当前文件解释“仓库现在有什么”。
3. Git 历史解释“何时、为何、由哪次变更形成”。
4. Validator/测试解释“契约能否复现”。
5. Receipt/Trace 解释“Agent 是否真的消费”。
6. 模型实验若存在，只能在冻结协议、隔离 Gold、成对可复现时解释任务效果。

前四类构成本 Skill 的静态评分与建设验收证据集。

## 为什么评分不是照搬某一家公司

公开实践给出方向，但没有一套跨 Harness 的统一百分制。本 Skill 的分值是风险分配：发现、路由、权威和执行直接决定“能否拿到正确上下文”，合计 60；预算、反馈、Skill 和生命周期决定“能否长期稳定治理”，合计 40。文档量表则把服务责任设为最高项，因为服务是代码、Owner、运行和局部知识共同演进的主要边界。

百分制是可审计的决策工具，不是自然定律。仓库可以在保留总分、P0 门禁和证据边界的前提下调整子项，但必须在本地 Rubric 记录风险理由、迁移前后映射和审批人。
