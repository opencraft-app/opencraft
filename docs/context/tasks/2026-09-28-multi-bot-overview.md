---
id: multi-bot-overview-2026-09-28
type: task
scope: 国际站多 Bot 总览与管理改版的实施任务。
triggers: ["多 Bot 总览", "multi-bot overview", "jasminzhao-zonglan-928"]
owner: jasminzhao
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-09-28-multi-bot-overview.md
status: active
reviewed_at: 2026-09-28
review_due: 2026-10-28
revision: 1.0.0
precedence: task
derived: false
---

# Task Pack：多 Bot 总览

## goal
落实用户提出的多 Bot 总览需求，突出创建入口并支持按目标 Bot 管理。

## non_goals
- 不发布，不改变后端/生产资源，不接管旧工作区任务。用户后续明确授权本需求 commit/push；不创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- `wiki/prd-docs/2026-09-28-multi-bot-overview.md`：全局总览、卡片管理、显式创建入口。
- 用户 2026-09-28 明确要求创建 `jasminzhao-zonglan-928`、整理 PRD 并启动开发。

## interface_refs / data_structure_refs
- `frontend/src/contexts/agent-context.tsx`：OpenClawBot、创建配额、列表。
- `frontend/src/repositories/types.ts`：renameBot/deleteBot/retryBot。
- `frontend/src/lib/agent-routes.ts`：目标 Bot query 与工作区路由。
- `frontend/src/pages/marketing/agent-buddy-profile.ts`：按 Bot/profile 读取资料。
- 不可将空 connectedChannels 当作离线，不可猜子 Bot profile 为 main。

## history_context
- current_design_refs：`frontend/DESIGN.md`、上述 PRD。
- relevant_evolution：相邻 `agent-multi-bot-onboarding.test.ts` 守护创建流程不重挂载、明确来源 Bot；profile-isolation 测试守护配置隔离。
- superseded_refs：初版单 Bot 资料卡仅用于兼容回落。

## acceptance
- 多 Bot 同屏、创建可见；操作按 ID 隔离；门禁和引导保持；未知统计显示占位。

## affected_paths
- frontend/src/pages/marketing/、frontend/src/i18n/generated/、wiki/prd-docs/、本 Task Pack。

## required_context
- frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | Git 授权与验证 |
| `docs/context/project/services/frontend.md` | 路由 must_read | 前端职责 |
| `docs/context/domains/site-environment-routing.md` | 路由 must_read | 双站/开关独立 |
| `frontend/AGENTS.md` | 服务边界 | 组件复用与门禁 |
| `frontend/DESIGN.md` | 样式规则 | 卡片、弹窗 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 邻接卡 | 定位相邻测试 |
| `.agents/context/change-impact.json` | 设计同步路由 | 当前营销页面及翻译不命中强制设计映射 |
| `docs/context/tasks/TASK-TEMPLATE.md` | 任务状态 | 本文件结构 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 续接状态 | 交接检查点 |

## evidence
- `git pull --ff-only origin master` 成功，基点 `15236bf99`。
- 分支 `jasminzhao-zonglan-928` 位于独立 worktree。
- 原工作区三项变更保存在命名 stash `preserve-context-before-jasminzhao-zonglan-928`，未混入新需求。
- 原 frontend 存在 unrelated `international-bot-onboarding` active change；新工作树单独启动 `multi-bot-overview-928`。

## risks
- profile/cron 数据跨目标串用：每次请求保持 Bot/profile 作用域。
- 现有页面状态门禁复杂：聚焦测试新手引导、升级和空态。

## validation
- frontend `pnpm check`、`pnpm test`、`pnpm build`；新组件行为测试和视觉验证。
- 根 context/documentation 验证、两个 unittest suite、context audit、change-impact staged 检查。

## decisions
- 用户已通过“整理 PRD 并启动修改”授权实施已展示方案，不重复申请方案批准。
- 开发范围暂按截图国际站推断，国内保留；询问站点范围尚待回复。

## scan_scope
- 前端总览/settings/profile/路由/Repository 邻居，禁止全仓扫描。

## scan_output
- 记录源码范围、相邻测试和数据可用性在本文件及 PRD。

## validation_results
- `pnpm check`：通过，166 条当前类型诊断/171 条基线，0 条新增；翻译结构无错误。
- `NEXT_PUBLIC_REGION=global VITE_REGION=global pnpm build`：通过，退出码 0。
- 聚焦 Vitest：11 文件、96 条通过。日志 `/tmp/zonglan-928-final-focused.log`。
- 实际组件浏览器 fixture：桌面与 390px 手机无横向溢出；重命名交互通过，无页面异常。仅模拟数据，未操作线上账号。
- `pnpm test`：未通过且有 worker 未结束，已停止本轮进程。对照干净 `15236bf99` 复现侧栏、模型配置、第三方包 ESM 等既有失败；总览新增后旧 mock 的缺失导出已修复并回归通过。
- 文档校验通过，context-audit 测试 33/33；context 单测 26 条中 4 项失败，干净 master 同名失败。
- `validate_context.py --build-catalog` 因仓库既有 context 元数据等错误未通过；本次 Task Pack 与检查点元数据已补齐，最终校验未报告这两份文件的问题。
- 实际改动集已暂存执行 `validate_change_impact.py --repo . --staged`：通过，未命中强制设计同步映射；`git diff --check` 通过。
- 完整日志位于本机 `/tmp/zonglan-928-*.log`，不包含合并/发布结论。

## handoff
- 前端实现与 PRD 已完成本地评审准备；当前 workflow 保留 verify。用户已明确要求“提交代码到远程”，本轮提交并推送指定分支，不创建 MR 或发布。
- 站点范围暂按国际站，国内同步待用户确认；真实账号操作仍待测试环境验收。
