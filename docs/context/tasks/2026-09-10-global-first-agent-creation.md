---
id: task-2026-09-10-global-first-agent-creation
type: task
scope: Restore international zero-instance Agent creation without enabling international multi-Bot.
status: active
owner: wisp/mono2-maintainers
created_at: 2026-09-10
---

# 国际站首次 Agent 创建回归修复

## goal
恢复国际站零实例用户的首次 Agent 创建入口，同时继续只在国内站开放实例内追加 Bot。

## non_goals
- 不在国际站开放多 Bot/Profile。
- 不修改实例创建 API、套餐配额或 Sandbox 创建流程。
- 不执行发布或生产变更；用户已授权提交、推送并创建 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户反馈：国际站零实例用户无法创建 Agent，前端没有发出 `POST /v1/instances`。
- `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`：本期多 Bot 只发布国内站，国际站不同步。

## interface_refs / data_structure_refs
- `frontend/src/contexts/runtime-config-context.tsx`：`useMultiBotEnabled()` 保持国内站区域门禁。
- `frontend/src/pages/marketing/agent-create-availability.ts`：套餐创建限制与创建权限。
- `frontend/src/repositories/http-repositories.ts`：国际站首次创建仍使用 `POST /v1/instances`。
- 不变量：首次实例创建不依赖多 Bot 开关；追加 Bot 必须依赖多 Bot 开关。

## history_context
- `current_design_refs`：`docs/engineering/domains/site-environment-routing.md`、`wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：`23b5bcdf1` 引入国内站多 Bot，并把共享的 `canCreateBot` 绑定到 `multiBotEnabled`，误伤国际站首次创建。
- `superseded_refs`：无。

## acceptance
- 多 Bot 关闭且未达到套餐限制时，首次 Agent 创建仍可用。
- 多 Bot 关闭时，追加 Bot 不可用。
- 多 Bot 开启且未达到套餐限制时，追加 Bot 可用。
- 达到套餐限制时，两类创建均不可用。

## affected_paths
- `frontend/src/pages/marketing/agent-create-availability.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-create-availability.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`

## required_context
- `site-environment-routing`
- `frontend/AGENTS.md`
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@2b72e31b2` | 仓库级交付边界 | 隔离 worktree、验证与发布边界 |
| `frontend/AGENTS.md@2b72e31b2` | 前端服务规则 | 测试和类型检查要求 |
| `docs/context/domains/site-environment-routing.md@2b72e31b2` | 国内/国际站边界 | 保持独立交付面和区域门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@2b72e31b2` | 前端配置与测试邻接 | 检查运行时开关及相邻测试 |
| `wiki/prd-docs/2026-09-09-lightvela-multi-bot-profile.md@2b72e31b2` | 多 Bot 发布范围 | 国际站不开放多 Bot |

## evidence
- 国际站线上 release `7f636c34d155` 与修复前 `origin/master` 均包含 `canCreateBot = multiBotEnabled && createLimitMessage === null`。
- `useMultiBotEnabled()` 在国际站固定返回 `false`，空状态按钮因此禁用且不会调用实例创建 API。
- 修复分支基于 `origin/master@2b72e31b2`，该版本仍可复现相同源码条件。
- 国际站和国内站聚焦测试各 `37 passed`。
- `pnpm check` 通过，TypeScript diagnostics 为 `175 current / 276 baseline / 0 new / 101 resolved`。
- `pnpm build:global` 通过，静态生成 `607` 个页面，SEO 检查通过；版本化静态资源检查因未启用 `NEXT_VERSION_STATIC_ASSETS=1` 而跳过。
- 完整 Vitest 套件在模型配置、套餐价格、续费提醒、国际首页静态片段和自动任务文档测试中报错，长时间运行后手动停止。未在未修改基线上逐项复跑，因此不声明这些失败已被证明是基线问题。
- documentation validation 与 docs-impact 检查通过。

## risks
- 风险：放宽共享条件可能误开放国际站追加 Bot。
- 缓解：分别建模首次实例和追加 Bot 权限，并覆盖关闭/开启多 Bot 及套餐限制测试。
- 回滚：恢复页面原创建权限表达式和对应测试。

## validation
- `pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 src/pages/marketing/__tests__/agent-create-availability.test.ts src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `pnpm check`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --check`

## decisions
- 保留 `useMultiBotEnabled()` 的国内站门禁；修复消费端，而不是为国际站开启该开关。
- 首次实例与追加 Bot 使用两个显式权限，避免以后再次混用。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-create-availability.ts`
- 相邻聚焦测试

## scan_output
- 有界源码搜索确认国际站创建最终调用 `POST /v1/instances`，阻断发生在空状态按钮。

## handoff
- 实现及聚焦回归、类型检查、国际站构建已完成；用户已授权提交 MR，待远端校验。未发布。

## checkpoint
- stage: 准备提交和创建 MR。
- verified: 国内/国际聚焦测试各 37 条通过，类型检查无新增诊断，国际站构建通过。
- unverified: 全量测试未通过；未执行线上真实实例创建。
- discard: 本地旧工作区的创建条件不代表线上已修复。
- restore: `codex/fix-global-first-agent-create`，基线 `2b72e31b2`，本 Task Pack 与四份前端变更。
- next_action: 提交并推送分支，创建指向 master 的 MR，确认远端 SHA 和 MR 状态。
