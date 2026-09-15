---
id: opencraft-environments-2026-09-11
type: task
scope: OpenCraft 独立环境管理入口、本机默认选择与已有配置复用。
triggers: ["环境入口", "environment configuration", "local host settings"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/environments-page.tsx
  - opencraft/apps/workbench-web/src/runtime/environment-projection.ts
status: retired
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
在 Chat 后添加“环境”，默认真实本机，独立选择配置目标并复用已有环境配置。

## non_goals
- 不切换当前聊天执行 Host，不伪造不存在的本机，不制造尚未提供的工具/权限配置。
- 不部署、提交或推送。

## requirement_ids / requirement_refs / requirement_excerpt
- ENV-01：应用导航顺序 Chat、环境、Settings。
- ENV-02：桌面默认本机，支持远程环境概览与连接管理。
- ENV-03：本机模型服务和默认模型配置复用现有实现，Settings 保留应用级项。
- ENV-04：环境选择、URL 和历史记录独立于聊天 Host 与草稿。

## interface_refs / data_structure_refs
- `ApplicationRoute.kind = environments`，`environmentId` 与 `section`。
- `SettingsPageContribution.environment` 显式声明配置页的 provider/可选精确 Host。
- `selectEnvironment` / `environmentSettingsPages` / `environmentEndpoint`。

## history_context
- current_design_refs：平台文档 Sidecar 主栏/上下文栏所有权。
- relevant_evolution：Local Agent 已有模型服务与默认模型页，服务固定请求 local Host；必须准确声明归属，禁止呈现为任意远程环境配置。
- superseded_refs：全局 Settings 下混排 Local Agent 与 Connections。

## acceptance
- 新入口默认本机并能进入现有编辑器；远程目标不出现本机配置。
- 浏览器历史返回 Chat 保留原 location/routeScope，草稿不变。
- 主题与窄窗遵循已有 Shell，截图与自动化验证。

## affected_paths
- `opencraft/apps/workbench-web/src/runtime/workbench-navigation*`
- `opencraft/apps/workbench-web/src/components/environments-page.tsx`
- `opencraft/packages/extension-contract/`
- `opencraft/plugins/builtin-agents/`

## required_context
- `opencraft/AGENTS.md`、平台设计、frontend-service-detail 路由输出。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md` | router must_read | 仅前端边界，不触及双站内容 |
| `opencraft/AGENTS.md` | 独立 workspace | gate、单一源码真源 |
| `workbench-navigation-transaction.ts` | 历史与激活所有者 | 环境导航不得调用聊天 activation |
| `plugins/builtin-agents/src/index.ts` | 本机配置注册 | 声明准确 environment ownership |
| `docs/context/domains/identity-access.md` | 桌面账户恢复 | 只调整异步启动顺序，保留授权和 generation 防护 |

## evidence
- 首轮源码与 Host profile/配置服务归属定位完成。
- 环境投影/导航/会话绑定聚焦 19 项通过；浏览器 fixture 验证本机默认、实际本机配置组件、远程不误用本机配置、连接入口、Chat 草稿恢复、Settings 分离、深色与窄窗通过。
- 桌面 Keychain 账户恢复改为扩展激活后的异步流程，本机 Shell 与环境配置不再等待第三方账户授权；增加延迟恢复不能覆盖用户退出状态的测试，桌面登录测试 25 项通过。
- 最终完整 gate 退出 0；macOS Preview 构建、签名与 ZIP 验证通过。
- Packaged Electron 实测：环境路径为 `/environments`，默认本机选中，显示概览/默认模型/模型服务；真实模型服务页可读取一个现有提供方，Add provider 可用，无 alert；返回 Chat 原 Host/draft 参数不变。预览留在本机模型服务页。

## risks
- 无效 URL/已移除环境不得静默回退到另一个目标并写配置。
- Endpoint 展示必须移除认证、query 和 fragment。

## validation
- 环境投影、导航和会话绑定测试，完整 gate，Web/Electron 实际页面。

## decisions
- 默认优先真实 enabled local profile；Web 无本机时选择已有环境或显示空态。
- 显式未知环境保留 unavailable，不偷偷切到本机。
- 旧 Settings 配置链接兼容导向环境；环境 Connections 继续使用已有添加/删除流程及当前聊天保护。

## scan_scope
- SettingsContent、BuiltinAgents settings、Host profiles、Workbench navigation、Shell。

## scan_output
- 环境声明过滤配置页，不能只按标题/字符串猜测归属。

## handoff
- 已实现并完成隔离浏览器与 packaged Electron 验收，新预览已打开。未提交或发布。

## stage
完成并交接本机配置入口。

## verified
- 路由/目标归属/脱敏单测，实际配置组件的本机请求，草稿恢复，深色与窄窗，完整 gate 和 macOS 预览。

## unverified
- 未修改真实模型配置、创建远程环境或删除 Host；这些写操作仍由用户在界面主动执行。

## discard
- 不能把浏览配置目标解释成切换聊天目标；不把已启用误报为连接就绪。

## restore
- 实测记录和截图位于 `/tmp/opencraft-environments/`，当前 native 调试端口 19555。

## next_action
- 用户直接在“环境 → 本机”配置模型；新提供方可通过 environment 声明注册配置项。
