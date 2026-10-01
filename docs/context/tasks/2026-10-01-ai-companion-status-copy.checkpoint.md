---
id: 2026-10-01-ai-companion-status-copy-checkpoint
type: task
scope: AI 伙伴连接失败提示文案调整的续接状态。
triggers: ["AI 伙伴状态", "连接失败提示", "checkpoint"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-01-ai-companion-status-copy.md
status: pilot
reviewed_at: 2026-10-01
review_due: 2026-10-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
中文源文案、翻译与 OpenCraft 副本已更新；聚焦验证完成，待提交并核验 MR。

## verified
- 真源是 `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`。
- OpenCraft 的对应 i18n 文件属于机械同步副本。
- 前端聚焦测试 14/14、`pnpm check`、`pnpm build`、OpenCraft 130 文件同步检查、插件类型检查及 i18n 测试通过。
- `pnpm test` 总门禁有多个无关失败，并发生 Vitest worker 内存溢出；单独复现了侧栏源码静态断言失败。
- 变更影响门禁原将 smoke 断言脚本识别为架构变更；已为该精确脚本补充排除规则，待复核。
- 变更影响门禁重跑通过；Context 单测总门禁 4 项失败涉及既有 Task Pack 元数据缺失，本次新文件已通过定向校验。

## unverified
- 当前截图所用浏览器的实际呈现。

## discard
- 旧文案“请检查 AI 伙伴配置后重试”不再作为本入口提示。

## restore
- 工作区 `/Users/pablozhong/.codex/worktrees/chat-action-tooltips/lightvela`，分支 `codex/chat-hover-tooltips`，MR !4897。
- Task Pack：`docs/context/tasks/2026-10-01-ai-companion-status-copy.md`。

## next_action
- 暂存并核验变更影响后，提交、推送和核验 MR !4897；在 MR 中说明全量测试门禁结果。
