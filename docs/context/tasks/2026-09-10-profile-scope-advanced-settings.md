## goal
让多 Bot 模式下的高级设置读取、保存和恢复默认严格作用于当前 Bot 对应的 Hermes Profile。

## non_goals
- 不修改 UI、文案、i18n、站点入口、后端 API 或实例级生命周期操作。
- 不提交、推送、创建 MR、发布或修改线上配置。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户会话请求：高级设置应沿用 Hermes 原生 Profile 隔离方式，修复当前未传递 `profileId` 的实现。
- 相关产品边界：一个产品 Bot 对应一个 Hermes Profile；根 Profile 的 LightVela 公开别名为 `main`。

## interface_refs / data_structure_refs
- `frontend/src/domain/types.ts`：`Bot.instanceId`、`Bot.profileId`。
- `frontend/src/lib/hermes-agent-command.ts`：`withHermesProfile()`、`getHermesProfileRootCommand()`。
- `frontend/src/repositories/types.ts`：`BotRepository.execDebugCommand()`。
- 不变量：`botId` 选择所属实例，`profileId` 选择实例内 Hermes Profile；两者不能互相推导替代。

## history_context
- `current_design_refs`：`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md` 仅作为需求背景；运行时源码和测试为本次实现真源。
- `relevant_evolution`：多 Bot 分支已将 Memory、Skills、自动任务和模型/通道路由接入 Profile，高级设置尚未接入。
- `superseded_refs`：原单 Bot 高级设置仅按实例 `botId` 执行命令。

## acceptance
- 命名 Profile 的读取命令绑定目标 Profile 的 `HERMES_HOME`。
- set/unset 生成 `hermes -p <profile>` 命令，且回读使用同一 Profile。
- `main` 继续映射 Hermes `default` 根 Profile。
- 聚焦测试、`pnpm lint`、`pnpm typecheck`、`pnpm test` 通过。

## affected_paths
- `frontend/src/pages/marketing/agent-common-settings.ts`
- `frontend/src/pages/marketing/agent-common-settings-save.ts`
- `frontend/src/pages/marketing/agent-common-settings-reset.ts`
- `frontend/src/pages/marketing/agent-common-settings-panel.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-common-settings*.test.*`
- `docs/context/tasks/2026-09-10-profile-scope-advanced-settings.md`

## required_context
- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@f2c0659e` | 前端服务硬规则与验证门禁 | 限定代码风格和测试要求 |
| `docs/context/project/services/frontend.md@cb0f61dc` | 前端服务边界 | 确认运行时执行权不能只靠 UI |
| `docs/context/domains/site-environment-routing.md@76873a4b` | 双站边界 | 确认本次不改变站点门禁，复用同一面板 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@99e5cc99` | 配置与测试邻接 | 选择相邻 Profile helper 和面板测试；本次无 i18n 变更 |

## evidence
- `AgentCommonSettingsPanel` 当前只接收 `botId`。
- `buildHermesCommonSettingCommand()` 与 unset 当前生成未带 Profile 的 `hermes config` 命令。
- `BotRepository.execDebugCommand()` 仅将 Bot ID 解析到实例级 `/debug/exec` 路径。
- `agent-memory.ts` 已通过 `getHermesProfileRootCommand()` 和 `withHermesProfile()` 隔离 Profile。

## risks
- 读取与写入若使用不同 Profile 会造成回读误判；通过同一参数贯穿并测试缓解。
- 主 Bot `main` 若直接成为目录名会破坏存量兼容；必须复用 `main -> default/root` helper。
- Profile ID 来自后端；必须复用现有 shell quoting，不直接拼接。

## validation
- 高级设置命令、保存、恢复、面板和页面边界聚焦测试。
- `pnpm lint`、`pnpm typecheck`、`pnpm test`。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged` 在存在 staged 变更时执行；本轮不主动暂存用户文件。

## decisions
- 复用现有 Profile helper，不新增另一套命令转义或 Bot/Profile 映射。
- 对外层 Profile 参数保留 `main` 兼容默认，但页面必须显式传当前 Bot 的 `profileId`。
- owner：当前用户与本次实现 Agent。

## scan_scope
- `frontend/src/pages/marketing/agent-common-settings*`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/lib/hermes-agent-command.ts`
- 对应相邻测试。

## scan_output
- 有界源码和测试检索，无独立扫描产物。

## handoff
- FE-AI Native 已完成 build 与 verify：高级设置读写链路已贯穿 `profileId`。
- 聚焦测试 6 个文件、94 个测试通过；`pnpm check`、`pnpm typecheck`、`pnpm build`、文档与 change-impact 门禁通过。
- 全量测试存在目标分支既有失败，具体证据和边界见 `.workflow/native/changes/profile-scope-advanced-settings/report.md`。
- 未提交、推送、创建 MR、发布或修改线上配置。
