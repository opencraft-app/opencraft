# /feai-archive — 请求归档当前需求

本命令是 FE-AI Native 归档薄入口；用户调用即明确请求归档当前需求，不代表批准未完成的设计、实现或验证。

先识别入口：仓库根存在 `scripts/feai-self.mjs` 且 AGENTS 声明本仓库自用工作流时，读取源码 `skills/feai-native/SKILL.md`，下文 `feai native` 全部映射为 `node scripts/feai-self.mjs`；其他项目读取安装版 `.codebuddy/skills/feai-native/SKILL.md`。

1. 运行 `feai native status --json`。无 active 时说明当前无可归档需求；如有恢复候选，展示候选等待选择，不自动恢复或新建。
2. 读取 active change 的 brief.md、report.md 与 continuation。未到 archive、缺少真实验证报告或有未解决的验证失败时，说明缺项，按 skill 处理；不得为归档伪造报告、跳阶段或自动确认设计。
3. 当前已到 archive 且报告支持验证通过时，执行 `feai native archive --json`。本次调用已提供归档授权，无需重复确认；失败时按 findings 处理，不宣称成功。
4. 成功后汇报归档位置、验证结论和遗留事项。归档不自动提交、推送、创建 MR 或上报用量。
