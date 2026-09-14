---
id: opencraft-anonymous-default-2026-09-11
type: task
scope: OpenCraft 匿名默认工作区与国内国际 Web 登录入口验收。
triggers: ["OpenCraft anonymous default", "Sign in entrance", "optional login"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/plugins/lightvela-hermes/src/extension.ts
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-11
review_due: 2026-12-11
revision: 1.0.0
precedence: task
derived: false
---

## goal
让未登录 LightVela 的用户默认进入可用的本地 OpenCraft Workbench，并只通过用户主动点击的 `Sign in` 入口启动国内/国际站 Web OIDC 登录。

## non_goals
- 不修改 LightVela OIDC、会话、实名或后端授权 contract。
- 不取消已登录但无 Bot 的 `bot-required` 引导。
- 不自动打开 Web 登录页，不执行真实登录。
- 不提交、推送或发布，除非用户后续明确授权。

## requirement_ids / requirement_refs / requirement_excerpt
- ANON-D-01：匿名启动显示本地 Workbench，不显示强制登录引导。
- ANON-D-02：匿名底部入口显示 `Sign in`，不是 `Account`。
- ANON-D-03：点击 Sign in 后才显示国内/国际选择；继续后沿用 Web OIDC。
- AUTH-D-01：已登录账号入口保留头像/名称/Account 行为。
- AUTH-D-02：已登录但无 Bot 的既有引导保持。

## interface_refs / data_structure_refs
- `PlatformAccountSnapshot.phase` 与 `applicationIntervention`。
- `ExtensionWorkbenchProjection.emptyWorkbenchNode` 与 `account`。
- `ShellNavigationConfig.account`。
- `LightVelaAccountService.signIn()` provider-neutral OIDC flow。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`docs/engineering/domains/agent-gateway-runtime.md`。
- `relevant_evolution`：账号状态和 Host/Workbench 所有权必须分离；认证状态不能伪装成 Host 不可用。
- `superseded_refs`：匿名状态下由 LightVela empty-workbench 接管主区的现状。

## acceptance
- 五条状态矩阵均有自动化或 live 证据。
- 匿名默认页可见本地新任务 Composer。
- 匿名底部入口为 `Sign in`；点击后才出现登录站点选择。
- 国内/国际选择仍生成对应 Web OIDC authority。
- packaged Electron Preview 实际启动、截图与 runtime error 检查通过。

## affected_paths
- `opencraft/apps/workbench-web/src/runtime/`
- `opencraft/apps/workbench-web/src/shell-navigation/` 或当前实际 shell path。
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/hostless-workbench.tsx`
- `opencraft/plugins/lightvela-hermes/src/extension.ts`
- `opencraft/tests/`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `docs/context/domains/identity-access.md`。
- `opencraft/AGENTS.md`、`opencraft/docs/platform-architecture.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@master` | 仓库行为变更与验证边界 | 创建 Task Pack、更新正式设计、跑门禁 |
| `opencraft/AGENTS.md@master` | Workbench/extension 构建边界 | 保持本地 Host 与 LightVela 插件分离 |
| `docs/context/domains/identity-access.md@master` | 登录/会话 Context | 不改后端认证 contract |
| `opencraft/docs/platform-architecture.md@master` | 账号状态与多端呈现所有权 | 匿名登录改为用户主动触发 |

## evidence
- 用户截图：匿名主区被 LightVela 登录卡接管；底部显示泛化 `Account`。
- `platformAccount.applicationIntervention` 的匿名投影改为 `null`；LightVela Host-specific `authentication-required` surface 保留。
- App 与 hostless shell 在匿名状态保留 provider；Shell footer 将其建模为直接 `Sign in` action，无 provider 时不制造 Account fallback，匿名时不恢复 pinned Account column。
- AccountView 匿名分支复用 `LightVelaLoginOptions`，点击 Sign in 后直接显示国内版、国际版与继续登录；`lightvela-account-auth.test.ts` 保持两区域 Web OIDC authority、PKCE 与回跳 contract。
- 聚焦及相邻测试 100 项通过；`npm run test:extensions` 116 项通过；Web/LightVela workspace typecheck、Web release 8 项、Build Matrix、documentation、change-impact 与 diff check 通过。
- `npm run package:electron:mac:arm64:preview` 退出 0；ZIP `OpenCraft-Preview-0.1.0-mac-arm64.zip` 完整性与 strict deep codesign 通过，文件摘要见当时的本地验收报告。
- 使用全新临时 user-data 启动 ZIP 解压产物：默认页显示 `What should we work on?`、Local 执行节点和 Composer，Sidecar footer 显示 `Sign in`；点击后直接显示登录站点选择，进程无 runtime error。
- 状态矩阵报告：`/tmp/opencraft-anonymous-validation.26ZuST/report.html`；结构化数据：`/tmp/opencraft-anonymous-validation.26ZuST/report-data.json`。

## risks
- 仅删除登录 surface 可能仍被 `applicationIntervention` 接管。
- 把匿名 account 设为 null 会触发 shell fallback `Account`；必须显式建模 anonymous action。
- 不得影响已登录无 Bot 的应用级 intervention。

## validation
- 聚焦投影、shell、LightVela account/OIDC 测试。
- `npm run typecheck --workspace @opencraft/workbench-web --workspace @opencraft/plugin-lightvela-hermes`。
- Electron Preview build、解压启动与 CUA 状态矩阵。
- 文档、change-impact 和相关 OpenCraft 门禁。

## decisions
- 匿名账户贡献继续存在，以提供显式 Sign in；但不再产生 application-level authentication intervention。
- 登录选择页继续由 LightVela account view 拥有。

## scan_scope
- 精确符号：`applicationIntervention`、`emptyWorkbenchNode`、`ShellNavigationConfig.account`、`platformAccount`。

## scan_output
- 临时 planning/findings/progress 已回写本 Pack，不进入最终变更集。

## handoff
- 当前状态：五条状态矩阵的代码/contract 验证完成；三条匿名桌面路径完成 packaged live QA，预览窗口保持打开。
- 下一步：用户确认后可 commit/pull/rebase/push；真实 Web OIDC 成功登录仍需测试账号另行验收。
- 阻塞项：无；本轮按安全边界未点击“继续登录”。
