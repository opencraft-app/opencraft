---
id: environment-navigation-persistence
type: task
scope: 保留模型服务的父级环境侧栏，页面切换不能隐藏环境选择和同级配置入口。
triggers:
  - 保留环境侧栏
  - 模型服务父级导航
  - environment navigation persistence
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-13
review_due: 2026-10-13
revision: 1.0.0
precedence: task
derived: false
---
## goal
进入模型服务后保留环境侧栏与同级入口，当前页面正确高亮。
## non_goals
不改 DSH、用户数据、全局历史，不实现其他尚未批准的整体工作区重构，不提交发布。
## requirement_ids
OC-ENV-PARENT-NAV
## requirement_refs
当前截图与用户确认。
## requirement_excerpt
“模型服务，也不要把侧边栏弄没了”“是的。搞起来。”
## history_context
current_design_refs: opencraft/docs/platform-architecture.md
relevant_evolution: 移除先前根据 master-detail 隐藏环境导航的错误规则。
superseded_refs: 前一轮让出父级导航的设计已被用户否定。
## context_receipt
| 文件 | 用途 |
|---|---|
| docs/context/project/services/frontend.md | 路由结果，仅本仓 OpenCraft 改动 |
| opencraft/.agents/skills/opencraft-maintenance/SKILL.md | 最小充分修改、父级归属 |
| opencraft/.agents/skills/opencraft-maintenance/references/verification.md | 原生验收 |
| opencraft/docs/platform-architecture.md | 修正导航契约 |
## acceptance
两套 Shell 不按子页布局删除父导航；实机概览与模型服务反复切换时同一导航节点保留并正确高亮。
## validation
聚焦测试、Web 类型检查、Electron 构建及独立预览。
## handoff
已完成并打开独立 Mac 预览，未提交发布。

## evidence
- 10 项聚焦测试通过；Web 类型检查与完整 npm run gate 通过。
- Electron 构建、打包及 codesign 严格验证通过。
- 原生窗口反复切换概览/模型服务，环境导航保持同一个 DOM 节点，当前入口 aria-current 正确；模型搜索值保留。
- 文档检查无错误，git diff --check 通过；暂存影响检查为空集。

## stage
实现与原生验收完成。
## verified
子页面布局不再决定父级导航存在性，模型配置数据未修改。
## unverified
未重构工作区局部历史及顶栏整合，也未做原生窄窗拖动验收。
## discard
此前用 master-detail 隐藏父导航的规则已废弃。
## restore
新包位于 opencraft/apps/workbench-electron/release/environment-parent-preview，独立 profile 不覆盖旧配置。
## next_action
用户预览反馈；不自动提交或发布。
