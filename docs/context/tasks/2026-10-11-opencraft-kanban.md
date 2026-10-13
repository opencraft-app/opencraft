---
id: opencraft-tasks-model-history-20261011
type: task
scope: Tasks 行存储与原生会话关联演进的有界历史。
triggers: ["opencraft-tasks-model-history-20261011 history", "2026-10-11-opencraft-kanban history", "2026-10-11-opencraft-kanban handoff"]
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

# Tasks 行存储与原生会话关联演进

## goal

按用户要求提供 SQLite 行存储，并将任务关联到真实原生会话。最初的独立看板卡片模型已被 Tasks 取代，本记录仅解释演进。

## requirement_refs / requirement_excerpt

用户要求使用 SQLite 行、考虑升级；随后明确任务采用 BB 级别抽象，旧卡片不需要迁移，不增加额外执行层。

## interface_refs / data_structure_refs

当前契约见 `opencraft/packages/appserver-protocol/src/tasks.ts`、`opencraft/plugins/tasks/src/sqlite.ts` 与正式任务模型。tasks/task_conversations 是业务真源；schema_migrations 在事务内记录版本和校验和。固定工作台后端拥有数据库，切聊天 Host 不切任务库；关系引用稳定 Server/Thread，允许多对多和跨 Server。

## history_context / decisions

原看板只表达卡片、列与可选会话链接，不能推导任务执行。用户批准以六个手动状态表达工作意图，原生活动单独读取；不把空闲判为完成。新建任务会话只准备原生草稿，用户发送后以 Thread 回执关联；关联未知结果先核对，不重放执行。目录只在同 Server 项目中复用。旧卡片不迁移或删除。

## acceptance / validation / evidence

此前 SQLite、控制器和 Host 14 项测试通过；原生提交、草稿连续性和导航回归通过。真实 Workbench 验证列表/看板、事务冲突、原生草稿与回执关联、同/跨 Server 项目放置、归属任务、文件预览原文件下载和手机布局。模型边界使用隔离替身或未配置账号，不声称真实付费推理。

完整门禁曾停在未修改的 Collaboration 不确定发送断言（75/76）。仅相关门禁及实际 Web 验证通过，未声称完整门禁成功。用户授权的预览已更新，但该历史阶段未合入 master。

## context_receipt

读取根与 OpenCraft AGENTS、维护 Skill 及验证清单、插件架构/持久化/平台设计和变更影响映射，用于固定 SQLite authority、共享 View 控件与最小协议边界。

## risks / handoff

真实手机、Electron、远端生产 Host 和付费模型未验证。当前契约以正式任务模型为准；最终 Git 交付见 `docs/context/tasks/2026-10-13-opencraft-mobile-header.md`。本记录退出默认路由。
