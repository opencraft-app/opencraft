---
id: opencraft-mobile-header-master-delivery-20261013
type: task
scope: OpenCraft Tasks、会话菜单、文件下载与手机顶部修复的 master 交付。
triggers: ["opencraft mobile header delivery", "2026-10-13-opencraft-mobile-header history", "2026-10-13-opencraft-mobile-header handoff"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/design/invariants.md
  - opencraft/docs/tasks-model.md
  - opencraft/docs/platform-architecture.md
status: active
reviewed_at: 2026-10-13
review_due: 2026-11-12
revision: 1.0.0
precedence: task
derived: false
---

## goal

将此前已验证的 Tasks 工作流、侧栏拓扑、会话操作和文件下载，以及手机顶部修复提交并合入最新 master。

## requirement_ids / requirement_refs / requirement_excerpt

- OC-TASKS-MASTER-20261013：当前用户会话授权的任务和手机顶部交付。

本次用户明确授权：“提交合入master”。此前用户要求任务使用 SQLite 行、真实关联原生会话，沿用工作台控件；手机顶部取消项目附文。该授权包含源码提交与合入。

## non_goals

不迁移旧看板卡片，不新增任务执行引擎，不修改生产或 GitOps，不在本次 Git 交付中重启当前预览。

## interface_refs / data_structure_refs

- `opencraft/packages/appserver-protocol/src/tasks.ts`：任务协议与 revision。
- `opencraft/plugins/tasks/src/sqlite.ts`：tasks/task_conversations 行与迁移校验。
- `opencraft/apps/workbench-web/src/runtime/task-conversation-flow.ts`：原生草稿、回执与关系交接。
- `opencraft/apps/workbench-web/src/components/conversation-task-menu.tsx`：会话操作与只读详情。

## history_context

- current_design_refs：上述正式设计与 `docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：Tasks 集成分支已提交至 `2e3958578`，尚未进入 master；本次从 master `a02f31d2c` 整合该分支，保留消息发送者、参与者和 master 后续更新。
- superseded_refs：旧卡片只作历史参考，不进入任务模型。

## acceptance

手机宽度不超过 640px 隐藏标题旁附文；桌面保留。会话“…”中的详情只读显示已知项目和同一 Thread 的完整目录，长路径换行，关闭恢复焦点。任务关系使用稳定 Server/Thread，文件下载保持原文件字节。

## affected_paths

`opencraft/plugins/tasks/`、协议与 Host 接线、Workbench 页面与菜单、侧栏、文件预览、对应测试和正式文档。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 交付边界 | 隔离工作树、验证与明确授权 |
| `docs/context/project/services/frontend.md` | Router 的 must_read | 确认该 Pack 属于 frontend，不能替代 OpenCraft 真源 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 路由邻接 | 选择 OpenCraft 对应语言和配置邻居 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` 与验证清单 | 布局和跨包交付 | 构建并验证真实 Web 与原生任务工作流 |
| `.agents/skills/gongfeng/SKILL.md` | 用户授权 Git 交付 | 复用已认证 mcporter 工蜂连接 |
| `opencraft/design/invariants.md`、`opencraft/docs/platform-architecture.md` | 当前设计 | 同步只读详情与手机呈现契约 |

## decisions

通过 Git 三方整合 Tasks 分支，保留最新 master 的发送者协议和设计约束。手机修复复用现有共享菜单、ModalSurface 和 Settings 控件，详情使用当前执行目录或同一 Thread 的规范元数据，不发起新的 IO 或执行。

默认 Git transport 认证不可用；工蜂 MCP 的只读认证成功。通过已认证 MCP 在 master 基础的新分支原子提交经过验证的完整差量，再创建 MR 合入；本地整合提交与远端提交可能因父节点与时间不同而具有不同 SHA，以远端结果为交付依据。

## validation / evidence

- 全 workspace 类型检查、i18n 和平台边界/字体检查通过；Web 构建通过。
- Tasks 14 项、相邻回归 48 项、标题写入/置顶 13 项测试通过。
- 新构建的真实 Workbench 验证列表/看板、SQLite 多对多、并发冲突、原生草稿/重载/显式发送/回执关联、同/跨 Server 放置、工作页、顶部归属/重命名/置顶及原文件下载。下载覆盖 Unicode 文件名、BOM/CRLF、二进制、空文件、图片、大文件和手机控件尺寸。
- 新 Web 构建与隔离合成身份/原生边界验证 390/640/641/1280px：标题不变、手机附文隐藏、完整目录换行、关闭恢复焦点，无页面溢出或异常；员工头像和参与者徽章保留。
- 新工作树独立安装依赖与 DSH；共享包依赖在同一 checkout 安装，React peer 解析到该 checkout 的 Workbench 实例，未借用其他工作树的依赖。
- 完整 gate 已运行；修正隔离安装的依赖解析后，全类型检查、边界、云桌面、Electron 启动及扩展前置测试通过。复验扩展根测试 247/247；Collaboration 包仍为 75/76，`im-chat-service.test.ts:181` 不确定发送断言实际 2、期望 1。相关实现/测试未改动；不声称完整 gate 成功。
- 文档链接检查无错误/警告；Context 审计脚本和 33 项审计测试完成。根 Context 测试 23/27，保留既有元数据、文档语言和服务摘要预算问题；新增/整合的 Task Pack 已补齐元数据并整理为中文有界历史，直接验证无指向这些变更文件的错误。
- 运行产物、生成 catalog、机器专用路径和认证均不提交。提交前检查实际 staged 设计影响及空白。

## risks

旧完整门禁曾存在 Collaboration 及布局断言失败；本次重新运行并如实记录，聚焦验证任务、消息身份、标题与下载。真实手机、Electron 和付费模型链路不由 Web 模拟验收代替。

## handoff

提交、MR 与 master 状态以实际工蜂回执为准。当前预览已有手机修复；本次合入不代表重新发布。
