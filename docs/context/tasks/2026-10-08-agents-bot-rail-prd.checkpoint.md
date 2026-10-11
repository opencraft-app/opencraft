---
id: agents-bot-rail-prd-checkpoint
type: task
scope: Recovery state for the Agents Bot rail PRD.
triggers: ["agents bot rail", "prd checkpoint", "agents interaction prototype"]
owner: pablozhong
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-08-agents-bot-rail-prd.md
status: active
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

## stage
根据用户最新桌面收起态反馈继续实现并核对本地预览；工蜂提交和 TAPD 仍未授权。

## verified
- 用户确认双站同步、最左竖栏头像直接切换、保留原宽侧栏导航；状态、重启／删除留在当前 Bot 卡片，新增 Bot 放在竖栏。
- 用户确认移动端在现有导航抽屉顶部使用横向 Bot 头像条。
- 用户最新反馈替代保留总览的旧决策：移除总览，切换 Bot 默认到新建会话；截图红框权益移入左下角账户入口，产品动态与定时任务推荐从 `/agents` 移除。
- 本轮收起态：左上复用 `lightvela-icon.svg`，Bot 与功能导航两列各 56px，左下账号头像旁保留可见箭头；5174 国内站实测顶部与底部均为 112px，账号菜单可打开。
- 干净 `origin/master` 基点 `ca706fe27dbc5722f9bafeeeebac5d13fd627692` 使用「日常／探索」和可折叠宽侧栏；Bot 切换由 `handleSelectBot` 更新 `?bot=`。
- PRD 与独立 HTML Demo 已写入本工作树；JavaScript 语法、文档链接和文档验证通过。修订版 PC 浏览器已核对从「探索」切换 Bot 进入目标空白新会话，左下账户入口展示权益；旧版曾核对手机头像条和创建禁用。
- 源码确认总览承载修改资料与复制 Bot 专有入口；修订稿将两者迁入当前 Bot 卡片管理菜单。

## unverified
- 双站灰度与上线时序；TAPD 与工蜂 MR 尚无用户明确授权，未创建。
- Demo 仅使用模拟数据；真实账号和产品代码未变更。

## discard
- 原脏工作目录里的「探索／对话」双 Tab 现状描述；干净基线的「日常／探索」为本稿依据。

## restore
- 工作树：`/Users/pablozhong/.codex/worktrees/agents-bot-rail-prd/lightvela`。
- PRD：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`；Demo：`wiki/prd-docs/demos/2026-10-08-agents-bot-rail.html`。
- 本 Task Pack：`docs/context/tasks/2026-10-08-agents-bot-rail-prd.md`。

## next_action
- 向用户展示 5174 国内站更新后的收起态并继续收集产品反馈；双站发布和工蜂提交仍待另行授权。

## requirement_ids / requirement_refs / requirement_excerpt
- `agents-bot-rail-2026-10-08`；见 `wiki/prd-docs/2026-10-08-agents-bot-rail.md`；双站独立 Bot 竖栏与总览退场。

## interface_refs / data_structure_refs
- `frontend/src/lib/agent-routes.ts` 的 `?bot=` 与 `frontend/src/pages/marketing/agent-settings-page.tsx` 的 Bot 切换入口。

## history_context
- current_design_refs：`wiki/prd-docs/2026-10-08-agents-bot-rail.md`。
- relevant_evolution：当时 PRD 基线为 `ca706fe27dbc5722f9bafeeeebac5d13fd627692`。
- superseded_refs：旧多 Bot 总览 PRD 仅作现状对照。

## context_receipt
- 见对应 PRD Task Pack 的 `context_receipt`。
