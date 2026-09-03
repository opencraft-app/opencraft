# /feai-start — 启动或恢复需求

> FE-AI 已切换为 Native 工作流。本命令是兼容入口。

读取并执行 feai-native skill（`.codebuddy/skills/feai-native/SKILL.md`），按其阶段契约工作：
先用 `feai native status --json` 判断状态；若有 active change 则继续，若返回 resume candidates 则先向用户确认并运行 `feai native resume --name <name> --json`，仅在无 active change 且无候选时用 `feai native new --name <kebab-slug> --json` 启动。

用户参数照原样理解：`--quick`/`--full`/`--yes` 仅作为需求规模与信任度的提示，由 AI 在 skill 的方法论自由空间内自决，不再有独立的流程分支。
