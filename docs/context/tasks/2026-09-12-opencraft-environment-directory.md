---
id: opencraft-environment-directory-2026-09-12
type: task
scope: OpenCraft 统一环境目录、Cordis 生命周期与 LightVela 发现数据源。
triggers: ["OpenCraft environment directory", "LightVela discovery", "Cordis environment source"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
status: retired
reviewed_at: 2026-09-12
review_due: 2026-12-12
revision: 1.0.0
precedence: task
derived: false
---

## goal
独立目录模块聚合本机、手动连接与 LightVela 账户实例，环境页及 Chat 消费同一目录。

## non_goals
不创建云资源、不变更生产、不提交；不替换连接与会话运行时。

## requirement_ids / requirement_refs / requirement_excerpt
- ENV-DIR-01：本线程用户要求统一目录、LightVela 作为数据源，并独立文件夹实现以稳定演进。
- requirement_refs：本线程；外部 PRD/TAPD 为 unknown。

## interface_refs / data_structure_refs
- `EnvironmentSource` / `EnvironmentEntry` / `EnvironmentDirectorySnapshot` 位于
  `workbench-runtime/src/environment-directory/contract.ts`。
- `EnvironmentProfileStore` 只投影发现条目，不持久化凭据或自动连接。

## acceptance
- 已有云实例登录后可发现，无需进入零环境页面。
- 云状态、连接状态、来源刷新状态分离，非运行实例不消失。
- 站点/账户/实例身份稳定，重复刷新和创建回流去重。
- 不自动切换当前 Host 或会话；账户退出、切换、来源卸载正确撤销目录权限。
- 独立文件夹、稳定接口、聚焦测试、完整 gate 与独立桌面验收。

## context_receipt
- `opencraft/AGENTS.md`：独立 workspace、生成层和 gate 边界。
- `opencraft/docs/platform-architecture.md`：Host 与 Shell 运行时边界（本线程已读，变更前复核相关段）。
- `opencraft/docs/build-matrix.md`：独立 mac preview 契约（本线程已读）。
- Router `opencraft environment directory Cordis LightVela` 无匹配；有界精确查阅 Cordis/profile/source 消费。

## history_context
已验证账户有一台 Running 实例。旧逻辑仅在零 Host 页面登记 velahermes0，本机默认存在后遗漏。
当前工作区含正在演进的环境创建流程，保持其接口与功能，不覆盖无关变更。
- current_design_refs：`opencraft/docs/platform-architecture.md` 与
  `docs/engineering/domains/agent-gateway-runtime.md`。
- relevant_evolution：从零 Host 空页自动登记升级为扩展生命周期发现；本机默认存在后旧路径不再运行。
- superseded_refs：`lightvela-hermes-empty-view.tsx` 的零环境登记不是新目录的发现入口。

## validation
完整 OpenCraft gate 通过（912 tests），新增 8 项目录/来源单测；独立 UI fixture
验证运行、停止、创建中、刷新失败保留、退出清空、主题与零自动连接。
Electron release、Preview 打包、strict deep codesign 和 ZIP 完整性通过。
正式设计 change-impact、git diff 检查、文档完整性通过；仓库上下文单测仍有
4 项既有失败，未扩大范围修复。

## affected_paths
- `opencraft/packages/workbench-runtime/src/environment-directory/`
- `opencraft/plugins/lightvela-hermes/src/environment-directory/`
- `opencraft/apps/workbench-web/src/runtime/environment-directory/`
- 环境 UI、账户 Host 绑定、创建回流、目录测试与正式设计。

## evidence
- `/tmp/opencraft-directory-gate.log`；`/tmp/opencraft-environment-directory-ui/`。
- 2026-09-12 用户处理账户恢复后，真实 mac 环境目录显示本机 Connected 与
  New Bot（国际站、运行中、Not connected），确认已有实例被发现且未自动连接。
- 用户继续操作后的界面显示 New Bot Connected，Chat 下已有历史会话，当前
  打开其历史会话；目录至连接与会话加载链路已验证。未由 Agent 发出聊天消息。
- 尝试刷新时用户改变窗口，停止进一步操作；该次手动刷新不计为验收证据。
- 界面模型请求显示额度不足 403；模型回复成功不属于本次目录验收结论。
- 上轮 137px 上限也已在新包独立 mac 验收（持针、键盘、旧值归一化）。

## decisions
- Cordis 服务拥有统一目录；LightVela 自有发现源负责站点/账户/实例身份与 API。
- 显式旧绑定保留 Host ID，缺失可验证绑定的历史配置不自动重指向其他机器。
- 发现注册 lazy factory，Chat 被动查询不主动连接新发现实例。

## risks
- 未经验证的旧单例绑定不能自动迁移，以免历史会话指向错误实例。
- 系统安全存储授权必须由用户处理，不导出或绕过凭据。

## handoff
源码、模型、UI 与真实账户实例显示验收完成，新包已启动。
未创建云资源，未提交/推送/发布；后续模型额度问题单独处理。

## stage
真实账户桌面验收完成。

## next_action
等待用户后续指示；不自动续费、创建实例或发送模型请求。
