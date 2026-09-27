---
id: cn-docs-public-beta-cleanup-checkpoint-2026-09-27
type: task
scope: 国内站公测说明清理交接。
triggers: ["cn docs checkpoint", "公测说明交接", "国内站文档交接"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-27-cn-docs-public-beta-cleanup.md
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## stage
国内站文案及本地门禁已完成；原 MR !4679 已合并，本轮独立 MR !4683 已创建。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids: CN-DOCS-PUBLIC-BETA。
- requirement_refs: 用户当前会话的截图与请求；外部 PRD 为 unknown。
- requirement_excerpt: “文档里面的公测说明，可以去掉了……也看下其他文档里面有没有类似的说法，也删掉吧”。

## interface_refs / data_structure_refs
- interface_refs: `frontend/src/content/docs/`、`frontend/src/app/llms.txt/route.next.ts`。
- data_structure_refs: `frontend/src/content/docs/last-updated.json`、`frontend/next-site/docs-route-manifest.ts`。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: MR !4679 第一批国内站文档改动已合并；本轮改动提交至新 MR !4683。
- superseded_refs: 旧公测转入时间线及延长权益仅供历史追溯。

## context_receipt
| 文件 | 用途 |
|---|---|
| `docs/context/tasks/2026-09-27-cn-docs-public-beta-cleanup.md@HEAD` | 本轮主 Task Pack |

## verified
- 截图所示提示框对应 `01-overview.md`；国内站另有适用人群、付费公告与 `llms.txt` 产品级公测口径，均已清理。
- DeepSeek Harness 与我的工作台当前产品入口仍显示 Beta。
- `pnpm docs:sync`、`pnpm check`、国内站 `pnpm build:cn`、69 项聚焦测试和文档 validator 均通过。
- 原 MR !4679 状态为 `merged`；新 MR !4683 创建时状态为 `opened`、`can_be_merged`，远端分支 SHA 与本地一致。

## unverified
- CI 创建时为 `pending` 且阻塞，最终结果待远端流水线完成。

## discard
- 公测转入时间线不再用于当前使用指南。

## restore
- worktree：`/Users/pablozhong/.codex/worktrees/cn-docs-batch-one/lightvela`。
- 主 Task Pack：`docs/context/tasks/2026-09-27-cn-docs-public-beta-cleanup.md`。

## next_action
跟踪 MR !4683 的 CI 与评审；合并及发布由后续流程处理。
