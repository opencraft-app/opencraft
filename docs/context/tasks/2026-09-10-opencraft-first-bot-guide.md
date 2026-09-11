---
id: task-opencraft-first-bot-guide-2026-09-10
type: task
scope: OpenCraft 在 LightVela 账号已登录但没有可运行 Bot 时，以跨 Web/Expo 共享的状态模型引导创建首个 Bot。
triggers: ["opencraft no bot", "first bot guide", "configuration-required"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-10-opencraft-first-bot-guide.md
status: active
reviewed_at: 2026-09-10
review_due: 2026-12-09
revision: 1.0.0
precedence: task
derived: false
---

## goal

当 LightVela 账号已认证但不存在可运行 Bot 时，Web 的零 Host 页面与 Host 连接干预页、Expo 的账户门统一进入 `bot-required` 状态并引导用户使用现有 `/dashboard/create` 创建流程。

## non_goals

- 不在 OpenCraft 内复制 mono2 `frontend/` 的订阅、实名、套餐与 Bot 创建事务。
- 不在本轮完成整个 ApplicationHome/Conversation 懒激活重构。
- 不修改生产、GitOps 或发布配置。

## requirement_ids / requirement_refs / requirement_excerpt

- `user-2026-09-10-no-bot-guide`：如果不存在 Bot，默认引导创建一个 Bot；抽出公共模块并尝试共享代码。
- 外部 Issue / MR：`unknown`。

## interface_refs / data_structure_refs

- `opencraft/plugins/lightvela-hermes/src/account/lightvela-account-service.ts`：Web LightVela 账号与可运行 Bot 目录真源。
- `opencraft/plugins/lightvela-hermes/src/account/lightvela-account-contract.ts`：Web/Expo 共享、无 renderer 依赖的账号词汇与地区配置。
- `opencraft/apps/workbench-expo/src/runtime/lightvela-account-types.ts`：Expo 账号投影。
- `opencraft/packages/extension-contract/src/index.ts`：`configuration-required` Host 干预表面。
- `frontend/src/pages/marketing/create-agent-page.tsx`：既有首个 Bot 创建流程；OpenCraft 只导航，不复制事务。
- 不变量：0 Bot 不是认证失败；创建按钮不得直接绕过 frontend 的资格与商业化检查；Home/空态本身不得持有 Host 连接。

## history_context

- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：LightVela Host provider 已用 `configuration-required` 表达无可用 Bot，但扩展仅注册了 `authentication-required` 表面；Expo 则把 0 Bot 压成普通 error。
- `superseded_refs`：无。

## acceptance

- 共享纯函数把账号 phase、Bot 数量与错误投影为 `loading / sign-in-required / bot-required / ready / error`。
- Web 的 empty-workbench 和 `configuration-required` 使用同一首 Bot 引导组件。
- Expo 0 Bot 不再显示“重试”错误，而显示创建 Bot 操作；其 JSX 保持 React Native 原生实现。
- 创建目标按国内/国际区域分别解析为 `https://lightvela.com/dashboard/create` 与 `https://lightvela.ai/dashboard/create`。
- LightVela 插件测试、Web/Expo/插件 TypeScript 检查通过。

## affected_paths

- `opencraft/plugins/lightvela-hermes/src/onboarding/**`
- `opencraft/plugins/lightvela-hermes/src/settings/lightvela-hermes-empty-view.tsx`
- `opencraft/plugins/lightvela-hermes/src/extension.ts`
- `opencraft/apps/workbench-expo/src/**`
- `opencraft/tests/lightvela-hermes-plugin.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- 路由器无匹配 Pack；按要求执行了限定源码搜索。

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@4ade2ce71` | mono2 交付、Task Pack 与验证约束 | 确定不发布、必须补正式设计与门禁 |
| `opencraft/AGENTS.md@4ade2ce71` | OpenCraft 共享边界 | 共享纯模型，Web/Expo 分别渲染 |
| `opencraft/docs/platform-architecture.md@4ade2ce71` | 双 renderer 所有权真源 | 禁止共享 DOM/RN 组件体 |
| `opencraft/plugins/lightvela-hermes/src/settings/lightvela-hermes-empty-view.tsx@4ade2ce71` | 当前零 Host 表面 | 提取首 Bot 引导并复用于干预页 |
| `opencraft/apps/workbench-expo/src/components/lightvela-account-gate.tsx@4ade2ce71` | Expo 当前账户门 | 修正 0 Bot 被压成 error 的分支 |
| `frontend/src/pages/marketing/create-agent-page.tsx@4ade2ce71` | 统一首 Bot 创建流程 | 仅导航至权威页面，不复制业务事务 |

## evidence

- `projectLightVelaBotOnboarding` 对国内/国际 0 Bot、ready 与非法 Bot 数量的聚焦测试通过。
- LightVela 扩展同时注册 `authentication-required` 与 `configuration-required`，账号贡献在未登录和 0 Bot 时给出对应应用入口干预。
- `npm run gate` 完整通过：平台边界、全部 workspace TypeScript、扩展 113/113、AppServer 119/119、Lab 40/40、Chat、Workbench、Web 发布测试，以及 Vite Web、Expo Web、Expo iOS 构建均通过。
- Expo Web 以 5,711 modules 完成 bundle，Expo iOS 以 3,479 modules 完成 bundle；共享 onboarding subpath 未引入 DOM 边界错误。
- 最终审计将地区、账号 phase 与 Bot 基础类型下沉到独立 `account-contract`；Web production build 与 Expo iOS 3,480-module bundle 再次通过。
- 应用级 intervention 已与 Host 连接 intervention 分流：前者在零 Host 时仍生效，后者才按 active Host provider 过滤。
- change-impact 与完整 documentation validator 通过；该高风险领域变更仍按规则需要 `wisp/mono2-maintainers` 在 MR 中复核。

## risks

- 用户在外部创建页完成后仍需刷新 Bot 目录；Web/Expo 在重新获得前台焦点时触发一次刷新，并保留显式刷新操作。
- Popup 被浏览器拦截；创建动作必须由用户点击直接触发。
- 回滚：移除共享投影与新增干预表面，恢复原 empty view/Expo error 分支。

## validation

- `cd opencraft && node --test --import tsx tests/lightvela-hermes-plugin.test.ts`
- `cd opencraft && npm run typecheck -w @opencraft/plugin-lightvela-hermes`
- `cd opencraft && npm run typecheck -w @opencraft/workbench-web`
- `cd opencraft && npm run typecheck -w @opencraft/workbench-expo`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`

## decisions

- 共享 renderer-neutral 状态投影与区域 URL；Web 使用 DOM 组件、Expo 使用 React Native 组件，owner：本任务。
- 应用级 intervention 不依赖当前 Host；只有真正的 Host 连接错误才按 active Host provider 过滤，owner：本任务。
- 首个 Bot 创建由 `frontend/dashboard/create` 继续拥有全部资格和创建事务，OpenCraft 只拥有入口与返回后刷新，owner：本任务。

## scan_scope

- `opencraft/plugins/lightvela-hermes/src/**`
- `opencraft/apps/workbench-web/src/**`
- `opencraft/apps/workbench-expo/src/**`
- `frontend/src/pages/marketing/**`

## scan_output

- 路由 query `OpenCraft AppHome no Bot shared creation guidance Web Expo hostless startup` 无 Pack 命中；限定搜索确认 `configuration-required` 已存在、Web 表面缺注册、Expo 将 0 Bot 抛为 error。

## handoff

- 当前状态：实现与完整门禁完成，尚未 commit、push 或发布。
- 下一步：用户确认后提交与推送；完整 ApplicationHome/Conversation 懒激活仍作为独立后续架构任务。
- 阻塞项：commit、push 与发布需用户明确授权。
