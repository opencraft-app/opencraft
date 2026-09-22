---
id: opencraft-codex-accounts-ui
type: task
scope: OpenCraft Codex account management UI and device-login flow.
triggers: ["Codex account UI", "Codex account settings"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.0
precedence: task
derived: false
---

## goal
把 Codex 账户页从通用双列设置表单改造成聚焦的账户资源管理界面：采用 Codex 的克制页面层级，并吸收 `ref/bb` 的账户列表、渐进披露和独立授权流程。

## non_goals
- 不改变 Host 侧账户、凭据、额度或 Thread affinity 的所有权。
- 不复制 `ref/bb` 的 Plugin SDK、Tailwind 实现或服务端模型。
- 不读取、显示或传递 OAuth secret。
- 不提交、发布、安装或替换用户当前应用。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-codex-account-ui`：用户要求参考 `ref/bb` 与 Codex 总体视觉，对当前低密度、操作平铺的 Codex 账户页进行全量整改。

## interface_refs / data_structure_refs
- `opencraft/plugins/builtin-agents/src/codex-accounts/view.tsx`
- `opencraft/packages/appserver-protocol/src/codex-accounts.ts`
- `ref/bb/plugins/account-pool/app.tsx`
- `ref/codex/modules/ui-islands-v12/settings-row-vx-5afdy.js`

## acceptance
- 添加账户为单一入口，登录和本机导入通过 Radix 菜单选择。
- 设备码授权在独立 Radix Dialog 中完成，验证码是视觉主对象，等待、取消和错误状态明确。
- 账户以紧凑资源行呈现身份、套餐、状态和额度；低频操作进入溢出菜单；详细元数据按需展开。
- 浅色、深色和 ZenCode 主题均只消费语义 token，无硬编码主题色。
- 窄窗口可折行但不隐藏关键操作；键盘焦点、菜单、Dialog 和确认流程由 Radix/共享控件负责。

## affected_paths
- `opencraft/plugins/builtin-agents/src/codex-accounts/`
- `opencraft/plugins/builtin-agents/package.json`
- `opencraft/apps/workbench-web/src/styles/codex-accounts.scss`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/codex-accounts-settings.test.ts`
- `opencraft/package-lock.json`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库硬边界与 Task Pack 要求 | 限定实现和验证范围 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft UI、Radix、主题与真实预览约束 | 确定组件和验证边界 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 维护工作流 | 选择聚焦测试和 Electron 验收 |
| `ref/bb/plugins/account-pool/app.tsx@62fe3bc46` | 账户领域交互参考 | 提取资源行、添加菜单、详情披露和授权流程 |
| `ref/codex/modules/ui-islands-v12/settings-row-vx-5afdy.js@reference` | Codex 视觉参考 | 提取组级容器、安静操作和紧凑密度 |

## risks
- 当前工作树存在大量并行未提交改动；只修改上述账户页相关文件，不整理或覆盖其他变更。
- Radix Portal 的服务端静态渲染与真实浏览器不同；结构测试和真实 Electron 呈现分开验证。

## validation
- `npm run typecheck --workspace @opencraft/plugin-builtin-agents`
- `npx tsx --test tests/codex-accounts-settings.test.ts`
- Web/Electron 构建后验证浅深主题、窄窗口、键盘菜单、设备码 Dialog 和删除确认。

## handoff
- 已完成 Codex 账户页的信息架构与视觉整改：单一添加菜单、紧凑账户资源行、额度槽、详情披露、溢出操作菜单、独立设备码 Dialog 与原位错误反馈。
- `@opencraft/plugin-builtin-agents` 与 `@opencraft/workbench-web` typecheck、202 项 AppServer 聚焦回归、平台边界、Electron renderer/host 构建均通过。
- 使用隔离 profile 和 CDP 9349 在真实 Electron 验证浅色空状态、添加菜单、方向键/Escape 焦点恢复、深色 ZenCode 与 760px 窄窗口；未读取或写入真实凭据，未执行真实 OAuth 完成或付费推理。
- 仓库级文档校验仍被既有断链 `docs/runbooks/nextgen-dashboard-argocd-cutover.md -> ../../scripts/ssm_manifest.nextgen-dashboard.beijing-sandbox.yaml` 阻塞，与本任务无关。
