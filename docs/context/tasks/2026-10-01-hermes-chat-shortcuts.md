---
id: task-hermes-chat-shortcuts-2026-10-01
type: task
scope: 新版聊天输入框的 Hermes 快捷指令实现与验证。
triggers: ["Hermes chat shortcuts", "composer slash commands", "快捷指令"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/chat-ui-architecture.md
  - opencraft/packages/codex-composer/src/codex-composer.tsx
status: active
reviewed_at: 2026-10-01
review_due: 2026-11-01
revision: 1.0.0
precedence: task
derived: false
---

## goal
在新版 OpenCraft Chat 输入框为 Hermes Host 增加旧 AgentChat 风格的快捷指令入口，并让运行中单独提交的 `/stop` 中断当前任务。

## non_goals
- 不修改 Hermes 运行时、网关或生产配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-01 请求及两张输入框截图：参考旧 AgentChat，在新版 Chat 输入框增加 Hermes 快捷指令。截图示例为 `/new`、`/compress`、`/status`、`/stop`、`/help`；后续追加 `/usage`。用户又反馈生成中发送 `/stop` 后回复仍继续，要求确认中断能力。

## interface_refs / data_structure_refs
- `CodexComposerProps.shortcutCommands`：由当前 Hermes Host 提供指令列表。
- `ComposerController.insertText` 写入当前草稿；`compileSubmitIntent` 将命令文本交给 AppServer，Hermes Bridge 的 `prompt.submit` 仍拥有发送权。

## history_context
- current_design_refs: `opencraft/docs/chat-ui-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution: 旧入口使用 `@tencent/agentchat-lightvela-panel`；新版入口使用 `CodexComposer`。
- superseded_refs: 无。

## acceptance
- Hermes 新会话及已有会话输入框显示指令库，六项菜单可键盘/鼠标选择，选中后内容留在草稿。
- `/` 联想对 Hermes 使用同一列表；非 Hermes Host 不显示该菜单。
- Hermes 已有会话在运行中提交单独的 `/stop` 时调用已有 `turn/interrupt` 链路，不把它排为下一条 `prompt.submit`；带正文或附件的输入不被误认成停止命令。
- 前端类型检查、聚焦组件测试、i18n 检查及相关构建通过。

## affected_paths
- `opencraft/packages/codex-composer/src/`
- `opencraft/apps/workbench-web/src/`
- `opencraft/docs/chat-ui-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- 前端产品界面：`frontend-product-surface`。
- 前端服务：`service-frontend`。
- 站点与环境路由：`site-environment-routing`。
- Agent 网关运行时：`agent-gateway-runtime`。
- 上游子树：`upstream-subtrees`。
- OpenCraft 服务：`service-opencraft`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | 旧 AgentChat 边界 | 区分旧入口与新输入框 |
| `docs/context/domains/site-environment-routing.md` | 双站边界 | 不把界面改动称为发布 |
| `frontend/AGENTS.md` | 前端规则 | 确认旧组件来源 |
| `docs/context/domains/agent-gateway-runtime.md` | Hermes 路由责任 | 保留 Bridge 执行权 |
| `docs/context/project/upstream-subtrees.md` | OpenCraft 源码归属 | 在 mono2 真源修改 |
| `docs/context/project/services/opencraft.md` | 新版 Chat 服务入口 | 选择 Composer 层 |
| `opencraft/AGENTS.md` | OpenCraft 规则 | 验证及生成层边界 |
| `opencraft/docs/chat-ui-architecture.md` | Chat 输入契约 | 草稿与提交分离 |
| `opencraft/docs/platform-architecture.md` | Web 与 Hermes Host 归属 | 不复制执行通道 |
| `opencraft/design/invariants.md` | 工作台交互不变量 | 保留输入焦点与草稿 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | UI 维护约束 | 复用 Radix 菜单 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 验证范围 | 聚焦真实 Composer |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 前端邻接检查 | 检查 i18n 与测试入口 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计映射 | 同步输入到执行的责任边界 |
| `docs/context/tasks/TASK-TEMPLATE.md` | Task Pack 格式 | 本文件结构 |
| `docs/context/tasks/CHECKPOINT-TEMPLATE.md` | 交接格式 | 记录当前状态 |

## evidence
- Router 的初始自然语言 query 未命中；路径 query 命中前端和 OpenCraft Pack。
- 有界搜索发现旧 `LightVelaPanel`、新 `CodexComposer`、Hermes `prompt.submit`。
- `npm run test:chat`：442 项通过；`npm run smoke:skill-autocomplete`：真实 Chromium Composer 交互通过，含 375px 窄屏与中文入口，截图在测试临时输出目录。
- Composer 与 Workbench Web 类型检查、`check:i18n`、`check:boundaries`、`build:lightvela-web`、`build:embedded-workbench:release` 通过。
- `validate_documentation.py` 与暂存变更集的 `validate_change_impact.py` 通过；`git diff --check` 通过。
- `npm run gate` 在未修改的扩展持久化测试中因预期值缺少 `artifactRef` 失败；该测试随后未退出，已停止进程。Context 全仓校验仍有既存错误，本次 Task Pack 的针对性错误已消除。
- 经本机代理打开的 `https://lightvela.com/agents/chat/` 实际运行隔离工作区的 Next 开发版；DevTools 记录到嵌入脚本从 `127.0.0.1:10001` 加载时因缺少 `Access-Control-Allow-Origin` 在 module 阶段失败。Vite 开发服务加入精确 Origin 列表后，请求带 `Origin: https://lightvela.com` 返回允许头，其他 Origin 不返回允许头；刷新浏览器后真实运行中 Hermes Bot 的历史会话、Composer 和五项指令菜单显示正常。
- 本次 CORS 配置修改后 `npm run typecheck --workspace @opencraft/workbench-web`、`git diff --check` 通过；浏览器未发送或执行任何 Hermes 指令。
- 追加 `/usage` 后，Composer 和 Workbench Web 类型检查、`check:i18n`、`smoke:skill-autocomplete` 通过；5174 模拟预览确认六项菜单包含“/usage 查看用量”，未发送指令。
- 后续截图显示运行中 `/stop` 已成为一条用户消息且流式回复继续；源码定位到 `sendMessage` 统一提交文本，经 `prompt.submit(queued: true)` 排队，而停止按钮经 `turn/interrupt` 调用 Hermes `session.interrupt`。现在对运行中的单独 `/stop` 复用停止按钮的中断链路。

## risks
- 指令执行效果依赖当前 Hermes 运行时；本次在真实已连接实例验证菜单与会话加载，未由开发者发送真实指令。
- 指令清单目前由 Workbench Web 按 Hermes provider 在前端定义，未从 Hermes 实时指令注册表加载；运行时版本与实际指令执行需单独核验。
- 全量门禁未通过，且没有执行真实 Hermes 指令。

## validation
- `npm run typecheck --workspace @opencraft/codex-composer`
- `npm run typecheck --workspace @opencraft/workbench-web`
- `npm run check:i18n`
- 聚焦 Composer 交互测试及 Web 构建。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions
- 指令库仅在 providerId 为 `lightvela.hermes` 时出现；点击填入而不自动发送，保留草稿控制权。
- 本地开发的 Vite CORS 配置和模拟页面仅用于预览，不纳入功能 MR。

## scan_scope
- `frontend/src/pages/marketing/agent-chat-panel.tsx`
- `opencraft/packages/codex-composer/src/`
- `opencraft/apps/workbench-web/src/`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/`

## scan_output
- 有界 `rg` 命中旧组件入口、新 Composer、Hermes Bridge；未保留完整扫描输出。

## handoff
- 源码、文档和测试交付至功能分支；本地模拟页面和代理配置留在工作区。MR 不等于合并或发布。
