## goal
将 LightVela 前端剩余的 Hermes 命令生成从 `@tencent/tea-sdk-lightclaw/scripts` 迁移到本地，彻底移除运行时 SDK 命令生成依赖，同时保持现有命令格式和行为。

## non_goals
- 本次不把一个 LightVela 实例改造成多个 Hermes Bot/Profile。
- 本次不统一追加 `--agent <profile-id>`，Profile 路由能力留待后续迭代。
- 本次不修改后端 Bot 数据模型或生产环境。
- 本次不提交、推送、创建 MR 或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：本期先彻底移除运行时 SDK 命令生成依赖；本地命令生成器统一显式传 `--agent` 暂不修改，维持现状。

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-config/scripts-runtime.ts`
- `frontend/src/pages/marketing/agent-config/hooks/useAgentInternals.ts`
- `frontend/src/pages/marketing/skills-demo/skill-registries.ts`

## history_context
- `current_design_refs`：`frontend/AGENTS.md`、当前前端源码与测试。
- `relevant_evolution`：配置面板已大部分迁入 mono2，本次移除剩余 scripts SDK 运行时桥接。
- `superseded_refs`：无。

## acceptance
- 前端运行时代码不再加载 `@tencent/tea-sdk-lightclaw/scripts`。
- Hermes Provider、模型、通道和 Gateway 命令由 LightVela 本地生成。
- 迁移前后命令文本保持一致，本期生成的命令不新增 `--agent`。
- 命令参数保持 shell 安全转义。
- 聚焦测试、类型检查、lint 与相关前端测试通过。

## affected_paths
- `frontend/src/pages/marketing/agent-config/`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/`
- `frontend/package.json` 及 lockfile（仅在依赖可安全移除时）。

## required_context
- 无匹配 Domain Pack；按路由器要求执行有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库边界 | 权限、验证与任务记录要求 |
| `frontend/AGENTS.md@working-tree` | 前端服务约束 | lint/type/test/build 门禁 |
| `docs/context/tasks/TASK-TEMPLATE.md@revision-2.1.0` | Task Pack 格式 | 记录本次行为变更 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | 前端变更影响映射 | 记录双站 Agent 配置命令所有权 |

## evidence
- `rg` 确认 `frontend/src` 与 `frontend/package.json` 不再存在 Tea SDK 主入口或 `/scripts` 子入口的运行时/类型 import；剩余命中仅为迁移历史注释和边界测试断言。
- `frontend/pnpm-lock.yaml` 只删除 frontend importer 的 3 行直接依赖；SDK package 条目因 `@tencent/agentchat-*` 传递依赖保留。
- 本地命令生成测试逐项锁定 Provider、模型探测/切换、QQ、企业微信、元宝、Telegram、Discord、Slack、钉钉、QR 和 Gateway 的既有命令文本，并断言不增加 `--agent`。
- `pnpm why @tencent/tea-sdk-lightclaw` 确认剩余两个版本均由 `@tencent/agentchat-*` 间接引入，frontend 不再直接依赖。

## risks
- 当前工作区已有 `agent-settings-page.tsx` 等用户改动；仅做局部增量并保留现有 diff。
- SDK 可能提供间接依赖；移除 package 前检查全部运行时和类型引用。

## validation
- 聚焦命令生成测试。
- `pnpm typecheck`
- `pnpm check`（仓库未提供独立 `lint` script）
- 相关 Vitest 测试。

## decisions
- 使用本地纯函数命令生成器保持现有 shell 转义和命令文本。
- Profile 路由与 `--agent` 参数不进入本期变更。

## scan_scope
- `frontend/src/pages/marketing/agent-config`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/package.json` 与 lockfile

## scan_output
- 使用 `rg` 记录调用点，不生成独立扫描文件。

## handoff
- 已完成本地实现与验证，未提交、推送、创建 MR 或发布。
- 聚焦命令/SDK 边界/通道测试：3 files、14 tests passed。
- 模型配置与 SDK 边界测试：7 files、167 tests passed（使用 Codex bundled Python 提供测试所需 `cryptography`）。
- `pnpm typecheck`：0 new diagnostics；`pnpm check`：passed。
- `validate_documentation.py`、`validate_change_impact.py` 与 `git diff --check`：passed。
