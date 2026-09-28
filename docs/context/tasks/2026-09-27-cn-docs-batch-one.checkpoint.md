---
id: cn-docs-batch-one-checkpoint-2026-09-27
type: task
scope: 国内站中文文档第一批优化的本地交接状态。
triggers: ["cn docs checkpoint", "国内站文档第一批", "文档交接"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-27-cn-docs-batch-one.md
status: active
reviewed_at: 2026-09-27
review_due: 2026-12-27
revision: 1.0.0
precedence: task
derived: false
---

## stage
第一批内容和注册已修改，本地必要门禁完成；第二、三批未实施。

## requirement_ids / requirement_refs / requirement_excerpt
- requirement_ids: CN-DOCS-B1。
- requirement_refs: 用户当前会话；外部 PRD 为 unknown。
- requirement_excerpt: “分三批实现……先改最重要的”。

## interface_refs / data_structure_refs
- interface_refs: `frontend/src/config/docs-sidebar.ts`、`frontend/scripts/sync-fumadocs-content.mjs`。
- data_structure_refs: `CN_SIDEBAR`、`CN_SLUG_TO_FILE`、`cnDocs`。

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`。
- relevant_evolution: 旧版三卡片页面已由当前管理台导航取代。
- superseded_refs: 本批已移除的旧截图流程描述。

## context_receipt
| 文件 | 用途 |
|---|---|
| `docs/context/tasks/2026-09-27-cn-docs-batch-one.md@HEAD` | 本次主 Task Pack |

## verified
- 国内站三处文档路由注册一致；文档同步、前端检查和国内站构建通过。
- 渠道一致性与日期测试通过；本批修改文档的摘要与相对链接检查通过。
- 变更影响门禁通过；新增 Task Pack 与 checkpoint 无 context schema 错误。

## unverified
- 线上登录态创建与钉钉授权流程尚未实测，发布前需核对。
- 钉钉开放平台应用类型、权限、回调仍待产品确认。

## discard
- 旧版三卡片截图、订阅后自动建 Bot 的历史口径。

## restore
- 独立 worktree：`/Users/pablozhong/.codex/worktrees/cn-docs-batch-one/lightvela`。
- 主 Task Pack：`docs/context/tasks/2026-09-27-cn-docs-batch-one.md`。

## next_action
保留本地修改供用户审阅；第二批从产品功能覆盖矩阵开始。
