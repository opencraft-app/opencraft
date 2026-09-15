---
id: opencraft-environment-create-entry-2026-09-11
type: task
scope: 环境列表下方的 LightVela 实例创建占位入口。
triggers: ["虚线创建入口", "LightVela 实例", "environment creation"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/components/environments-page.tsx
  - opencraft/plugins/lightvela-hermes/src/onboarding/lightvela-bot-onboarding.ts
status: retired
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
按用户确认的示意实现轻量应用内添加：条件检查、名称确认、后台创建、原位状态、绑定新实例；条件不足才引导官网。

## non_goals
- 不实际创建云实例、购买订阅、部署官网、提交或推送。
- 不创建同实例内的命名 Bot，不改变已有 velahermes0 的稳定绑定规则。

## requirement_ids / requirement_refs / requirement_excerpt
- CREATE-ENTRY-01：用户截图红框位置增加虚线加号，进入 LightVela 实例创建流程。

## interface_refs / data_structure_refs
- `PlatformAccountContribution.environmentCreation`：由提供方贡献 label/viewId；Shell 只负责展示、Modal 与进度条目。
- `LightVelaEnvironmentService`：read-only precheck → explicit POST → accepted ID polling → local Host registration；按 account ID/region 持久化非敏感进度记录。
- 官网 `agent-settings-page.tsx:handleCreateNew`：空实例状态订阅检查与创建确认。
- `http-repositories.ts:createBot`：初始实例与已有实例内命名 Bot 是不同 API。

## history_context
- current_design_refs：平台文档 Fixed navigation entrances；正式 agent-gateway-runtime 设计。
- relevant_evolution：环境路由已与 Chat 分离；系统浏览器处理 Electron 外链。
- superseded_refs：`/dashboard/create` 双站 HTTP 404；`creating=true` 只控制创建中展示。

## acceptance
- 虚线入口在本机条目下方、配置分隔线之前，明暗主题与键盘焦点可用。
- 匿名点击打开可关闭登录；认证后检查 active pass、agent_quota_available，提交前重新检查；shadow binding 由 CreateInstance 在资源分配前原子校验。
- POST 单次确认且不自动重试；返回后原位跟踪 GET instance；Running 后新增明确绑定的 Host，不切换聊天。
- 条件不足提供区域官网链接；未知 POST 结果禁止自动重发；账户切换不泄露或接入旧请求。
- 不切换聊天 Host/草稿；通用加号仍进入连接管理；没有账户扩展不显示产品创建入口。

## affected_paths
- OpenCraft EnvironmentNavigation、账户贡献接口、LightVela extension/onboarding、fixture 与测试。

## required_context
- router 无匹配；有界精确检索环境导航、账户贡献和现行创建流程。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | workspace 边界 | 不触发官网发布 |
| `opencraft/docs/platform-architecture.md` | 导航归属 | 保持配置与聊天独立 |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | 官网创建真源 | 验证有效入口而非猜测 URL |
| `frontend/src/repositories/http-repositories.ts` | 实例与 Bot API | 不混淆创建资源 |

## evidence
- 旧创建 URL 双站 404；现行 `/agents` 页面含空状态创建确认及订阅跳转。
- 图索引未匹配 EnvironmentNavigation/lightVelaBotCreationUrl/PlatformAccountContribution，使用精确源码定位。

## risks
- 官网已有实例时会展示管理页，是否可新增由官网权益决定；本入口不绕过限制。
- 测试仅拦截外链或打开只读页面，禁止真实资源创建。

## validation
- 聚焦环境与扩展/IPC 测试；浏览器 7 状态 fixture；完整 gate；macOS 预览构建与入口检查。

## decisions
- 复用现有 CTL API，不修改后台权限或商业规则。官网保留购买与账号开通职责。
- 新 Host 使用稳定随机 ID，instanceId 是明确绑定而不是命名空间；旧 Host 行为兼容。
- 使用原生按钮/链接和既有 Plus 图标，虚线样式全用主题变量。

## scan_scope
- OpenCraft 环境/账户/onboarding；官网 agent-settings-page/createBot。

## scan_output
- 创建 API 与实例轮询契约已核对；pass 的 agent_quota_available 来自服务端实例额度，不是模型积分。
- 原生实测 create-prerequisites 返回 404；源码仅存在 handler、没有 mux 路由注册。移除对此不可用 API 的依赖，使用现行 passes + CreateInstance 原子校验。

## handoff
- 创建流程已实现。最后一次 OpenCraft 完整 gate 退出 0，环境聚焦 16 项通过，隔离 UI 7 场景通过；macOS 签名与 ZIP 验证通过，实机入口与匿名登录小窗口可用。没有实际创建云资源、支付或生产写操作，未提交/推送。
- 工作区并行环境目录实现接管发现回流：onInstanceReady 接收刚创建的 ID，确认目录出现该实例后结束跟踪，避免额外保存重复 Host。保留另一任务的改动。

## stage
完成本轮实现与验证；真实开通由用户主动确认。

## verified
- Electron 外链 handler 使用系统浏览器，不嵌入认证页面。
- 88 项聚焦测试通过；完整 gate 退出 0；创建 UI 的正常/后台/完成/条件不足/深色窄窗/匿名/未知结果 7 场景通过。
- 文档校验 errors=[]，显式文件集设计影响检查与 staged 检查通过。
- 集成收敛后完整 gate 再次通过，记录 `/tmp/opencraft-env-handoff-gate.log`；最终环境测试 16 项通过。
- 仓库级 context 单测 26 项中有 4 项失败，来自现有/并行 Task Pack 契约不完整；context-audit 的 33 项测试通过。没有为本次功能修改其他任务文档来消除这些问题。

## unverified
- 真实实例创建未执行；macOS 新包只做入口与只读条件检查，不触发创建 POST。
- 当前打包应用显示匿名登录分支；有额度创建、后台进度、拒绝/未知结果以真实组件和模拟服务验收，不能描述成已完成真实云开通。

## discard
- 旧 `/dashboard/create`、伪造 `creating=true` 创建语义。

## restore
- 保留工作区此前环境/登录/账户改动，禁止覆盖或重置。

## next_action
- 用户可在“环境 → 添加环境”登录后操作；如需实际开通验收，须单独明确授权真实资源创建。
