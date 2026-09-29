---
id: global-docs-public-beta-cleanup-checkpoint-2026-09-27
type: task
scope: 国际站公测说明清理交接。
triggers: ["global docs checkpoint", "国际站文档交接", "公测说明交接"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-27-global-docs-public-beta-cleanup.md
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## stage
国际站六种语言文案已修改，本地生成与门禁已完成，独立 MR !4687 已创建。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids: GLOBAL-DOCS-PUBLIC-BETA。
- requirement_refs: 用户当前会话；外部 PRD 为 unknown。
- requirement_excerpt: “国际站文档里面关于公测期的描述也去掉了吧？”

## interface_refs / data_structure_refs
- interface_refs: 国际站语言源、`sync-fumadocs-content.mjs`、`seo-data.ts`。
- data_structure_refs: `last-updated.json`、`docs-route-manifest.ts`。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 国内站 MR !4683 已合并；国际站仍保留公测转段与内测延期旧文案。
- superseded_refs: 2026 年 8 月公测安排不再作为当前操作指南。

## context_receipt
| 文件 | 用途 |
|---|---|
| `docs/context/tasks/2026-09-27-global-docs-public-beta-cleanup.md@HEAD` | 本轮主 Task Pack |

## verified
- 六种语言中相关整站公测说法已定位；功能级 Beta 和第三方比较页另行保留。
- 文档同步、`pnpm check`、国际站构建、164 项聚焦测试及文档 validator 通过。
- 生成的 en-us、zh-sg、zh-hant、id-id、es、ja-jp、ko-kr 文档中未发现整站公测口径。
- 本轮变更见 MR !4687，目标为 `master`。

## unverified
- 新 MR 的 CI 最终结果待流水线完成；远端 source SHA 和 mergeability 在交接前核对。

## discard
- 公测转段时间线和内测用户延期承诺不再作为当前文档口径。

## restore
- worktree：`/Users/pablozhong/.codex/worktrees/cn-docs-batch-one/lightvela`。
- 主 Task Pack：`docs/context/tasks/2026-09-27-global-docs-public-beta-cleanup.md`。

## next_action
跟踪 MR !4687 的 CI 与评审；合并及发布由后续流程处理。
