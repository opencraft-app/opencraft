---
id: opencraft-tasks-work-page-history-20261012
type: task
scope: Tasks 工作页和会话顶部操作的有界历史。
triggers: ["opencraft-tasks-work-page-history-20261012 history", "2026-10-12-opencraft-tasks-ui history", "2026-10-12-opencraft-tasks-ui handoff"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/tasks-model.md
status: retired
reviewed_at: 2026-10-13
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

# Tasks 工作页和会话顶部操作

## goal / requirement_refs

用户要求看板能够实际投入使用：收紧卡片、使用独立任务工作页，并从原生会话顶部设置归属任务。随后授权重命名、置顶、整合最新 master 和切换预览。

## non_goals

不增加自动执行、依赖引擎、独立卡片库、自动保存或另一套浏览器历史。

## interface_refs / decisions

`opencraft/plugins/tasks/src/view.tsx`：列表与看板读取同一权威快照；卡片只显示标题、活动摘要和一个会话捷径。详情使用任务 View，宽容器显示属性栏，窄容器堆叠同一字段。保留隐藏概览节点、滚动和草稿，关闭返回仍有效的入口焦点；不以 Dialog 代替任务工作页。

`opencraft/apps/workbench-web/src/components/conversation-task-menu.tsx`：已有会话“…”提供归属任务、重命名和置顶。关系使用固定任务 authority 与稳定 Server/Thread；管理动作独立消费原生能力和既有标题写入者。账号/Host/Thread 切换撤销旧 UI，关系行反馈不污染父级草稿。

## history_context

集成分支 `feat/opencraft-tasks-header-integration-20261012` 已提交，并整合当时 master。推送回执核对至 `48bc0a99e`，后续文档提交至 `2e3958578`；当时尚未合入 master。运行后端和数据被保留，只替换 Web 资源。

## context_receipt

读取根与 OpenCraft AGENTS、维护/预览 Skill、平台架构、任务模型、设计不变量和原生会话管理实现；用于界定草稿与写入权威、共享控件、静态资源发布和回退。

## validation / evidence

Tasks 14 项领域/后端测试及相关标题、员工身份、导航与文件预览回归通过。真实 Workbench 使用独立 SQLite 和原生目录验证多对多关系、冲突保留输入、任务草稿/发送/回执关联、路由恢复、归属任务，以及桌面属性栏与手机堆叠布局。

最终运行包 Workbench 验证通过；独立静态发布与入口回退验证成功，后端进程和运行时未替换。实时页面只读检查会话菜单，未修改用户任务、标题、置顶或会话关系。完整门禁未声称通过。

## risks / handoff

物理手机、Electron、生产远端 Host 和真实付费模型未验证。最终 master 交付与最新复验见 `docs/context/tasks/2026-10-13-opencraft-mobile-header.md`；本记录退出默认路由。
