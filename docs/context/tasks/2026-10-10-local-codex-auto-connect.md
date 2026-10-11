# 本地 Codex 默认自动连接

## goal
Web 与 Electron 内置 local-codex 默认自动连接。

## non_goals
- 不重启当前服务，不提交、推送或发布；不更改 SSH 连接、当前聊天选择或连接协议。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前会话：用户要求“默认本地 codex 就应该连接上”“不过你不要重启”“改起来吧”。

## interface_refs / data_structure_refs
- `opencraft/plugins/builtin-agents/src/index.ts`：两端 local-codex 的 autoConnect。
- `opencraft/apps/workbench-web/src/runtime/host-thread-catalog.ts`：准入与 ensureConnected。
- `opencraft/apps/workbench-web/src/runtime/host-profile-contributions.ts`：插件贡献为启动期临时 profile。

## history_context
- current_design_refs：`docs/engineering/domains/agent-gateway-runtime.md`、`opencraft/docs/platform-architecture.md`。
- relevant_evolution：基线 6527da25172ab128e45c3150026d01ca236dcc80 中两端 local-codex 均为 autoConnect false。
- superseded_refs：旧源码 checkout 仅作定位，不作为编辑目标。

## acceptance
- 两端 local-codex 默认自动连接；现有会话目录流程可建立连接；远端 SSH 默认行为保持原状。
- 插件类型检查、Host 相关聚焦测试通过；当前服务不重启。

## affected_paths
- `opencraft/plugins/builtin-agents/src/index.ts`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- agent-gateway-runtime、site-environment-routing、upstream-subtrees、service-opencraft。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`、`opencraft/AGENTS.md` | 修改与验证边界 | 不重启、不发布 |
| `docs/context/domains/agent-gateway-runtime.md` | 运行时责任 | Host authority |
| `docs/context/domains/site-environment-routing.md` | 路由必读 | 不涉及站点部署 |
| `docs/context/project/upstream-subtrees.md` | 真源边界 | mono2 内修改 |
| `docs/context/project/services/opencraft.md` | 服务入口 | 聚焦验证 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`、`opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | 维护验证 | 区分源码与当前实例 |
| `opencraft/docs/platform-architecture.md` | Headless Host 生命周期 | 复用连接路径 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 正式设计 | 同步默认行为 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | 配置邻接 | 检查 Host 配置与会话目录相邻测试；不涉及 frontend |
| `.agents/context/change-impact.json`、`docs/context/tasks/TASK-TEMPLATE.md` | 文档门禁 | 记录变更范围 |

## evidence
- 编辑前 worktree 干净，两端 local-codex 的 autoConnect 均为 false。
- 会话目录准入消费 autoConnect，读取目录调用 registry.ensureConnected；本轮复用该流程。

## risks
- 服务或凭据异常仍可能连接失败；此次仅改变默认连接意图。
- 回退两处默认值即可恢复此前行为。

## validation
- `npm run typecheck --workspace @opencraft/plugin-builtin-agents`：通过。
- `node_modules/.bin/tsx --test tests/workbench-web-host-definitions.test.ts tests/host-thread-catalog.test.ts`：22 项通过。
- `npm run test:bot-management`：32 项通过。
- `git diff --check`：通过；插件未定义独立 lint 脚本。
- `validate_change_impact.py --repo . --staged` 附带本轮两个 changed-file：通过。
- 未构建、替换运行产物或进行真实客户端连接验收；遵守不重启要求。

## decisions
- 仅将两端 local-codex 的 autoConnect 改为 true，不添加新连接流程。

## scan_scope
- builtin-agents、Host profile 与 thread catalog；无凭据读取。

## scan_output
- 无敏感信息扫描产物。

## handoff
- 源码两处默认值已修改，类型检查和 54 项聚焦测试通过。未提交、推送、替换构建产物、重启或发布；当前实例尚未应用修改。
- 后续用户授权重启后，当前 Headless Web 产物已更新并重启成功。unit 为 opencraft-migrated.service，当前 PID 4105550，端口 80 正常监听；Web buildId 为 20261010-local-codex-auto-412571440ce9。干净 Chromium 页面自动连接 local-codex 并成功读取会话目录，零页面错误、零资源加载失败；后端 bundle 哈希与切换前相同。桌面源码默认值也已修改，未另行构建/发布 Electron 安装包。未提交或推送。

## checkpoint
- 2026-10-10：实现与源码检查完成；运行实例保持原状。用户未授权本轮重启，实际客户端连接留待后续应用新构建时验证。
- 2026-10-10 后续授权：用户要求“然后重启一下算了”，覆盖此前不重启限制。当前 unit 为 opencraft-migrated.service，端口 80；Web 基线为 20261008-reasoning-markdown-6b733c2f6，后端运行时另有现场修复，故只按源码默认值变更修补当前 Web 产物，不从较旧 checkout 重建后端。
- 候选产物、原 Web 备份和独立切换/回退脚本位于 `/data/opencraft-local-codex-autoconnect-20261010/`。业务代码只修改 Headless local-codex 的 autoConnect；新资源地址和引用同步更新，保留原资源以支持旧客户端与回退。
- 候选使用当前真实后端与隔离数据根启动，通过真实 Chromium 验收：无点击自动连接成功，thread/list 成功，页面错误和资源失败均为零；没有发起推理。候选 buildId：20261010-local-codex-auto-412571440ce9。
- 下一步由独立 systemd service 发布 Web 入口、重启当前 unit，并以干净浏览器验证实际运行版本；不改变数据目录或后端 bundle。
- 切换已完成；重连后再次核对当前 unit、监听 PID 和 HTTP version.json，与独立任务验收一致。证据为 switch-result.json 和 live-verified.json，保留旧 Web 备份用于回退。
