# 国内站 Soul 新推荐排除高风险人设 Task Pack

## goal

国内站新抽卡、重抽和人设测试不再推荐 `LOVE-R`、`SOLO`、`GRASS`。

## non_goals

- 不删除用户已有卡片或已注入的 `SOUL.md`。
- 不修改 SkillHub 目录、Soul 正文或国际站推荐。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户本轮要求：这三张卡参考 `MUM`，从新抽卡、重抽和人设测试推荐中隐藏。
- 范围沿用本轮讨论的国内站；MUM 既有行为见 `docs/context/tasks/2026-10-01-hide-mum-soul-card.md`。

## interface_refs / data_structure_refs

- `getRecommendableSouls` 产出新推荐候选；`sourceSouls` 保留完整目录供历史卡片本地化。
- `SoulTestModal` 从传入候选建立 `availableSoulIds`，只在候选内匹配。
- `SkillHubSoul.slug` 与 `toCanonicalSlug` 负责统一国内/国际命名空间。

## history_context

- `current_design_refs`：`frontend/openspec/specs/buddy.md`、`docs/context/tasks/2026-10-01-hide-mum-soul-card.md`。
- `relevant_evolution`：MUM 已从新推荐排除，历史卡片和已注入状态保留。
- `superseded_refs`：无。

## acceptance

- 国内站抽卡、重抽及测试候选不含三张目标卡，也不含既有的 MUM。
- 国内站已保存的目标卡仍展示，已注入状态不被清除。
- 国际站维持现有候选行为；相关测试、前端检查与构建通过或记录阻断。

## affected_paths

- `frontend/src/pages/marketing/agent-buddy-localization.ts`
- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-localization.test.ts`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-soul-test-modal.test.tsx`
- `frontend/openspec/specs/buddy.md`

## required_context

- `site-environment-routing`、`frontend-product-surface`、最近的 `frontend/AGENTS.md`。

## context_receipt

| 文件 | 阅读原因 | 用途 |
| --- | --- | --- |
| `docs/context/domains/site-environment-routing.md@f3db0e91` | 双站边界 | 确定国内站范围 |
| `docs/context/project/services/frontend.md@f3db0e91` | 前端服务门禁 | 确定验证要求 |
| `frontend/AGENTS.md@f3db0e91` | 服务指令 | 保持最小改动和测试门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@f3db0e91` | 邻接路由 | 检查相邻测试 |
| `frontend/openspec/specs/buddy.md@f3db0e91` | 当前模块规格 | 保留历史与注入行为 |
| `docs/context/tasks/2026-10-01-hide-mum-soul-card.md@f3db0e91` | 历史实现 | 复用候选/历史分离模式 |

## evidence

- `origin/master` 的 MUM 过滤在 `getRecommendableSouls`；`BuddyPanel` 将完整目录用于历史卡，把过滤结果传给抽卡和测试。
- `SoulTestModal` 把传入候选转为 `availableSoulIds` 再匹配；重抽复用同一个抽卡候选池。
- 4 个聚焦测试文件通过，56/56 项；`pnpm check`、`pnpm build:cn`、文档校验和 `git diff --check` 均通过。

## risks

- 过滤完整目录会让历史卡片失去最新名称；只过滤新候选。
- 测试若在完整权重表匹配可能选中隐藏项；继续按候选集合匹配。

## validation

- `pnpm exec vitest run --config .codex-vitest-127.config.ts` 加 4 个聚焦测试文件：56/56 通过。临时配置只把 Vite host 和 JSDOM URL 改为 `127.0.0.1`，已删除；仓库配置使用 `localhost`，本机 `/etc/hosts` 为空，直接运行会在启动阶段报 `ENOTFOUND localhost`。
- `pnpm check`：通过，TypeScript 新增诊断 0；本服务未配置单独 `lint` 脚本。
- `pnpm build:cn`：通过；构建生成的字体及 `next-env.d.ts` 已还原。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，错误 0。
- `git diff --check`：通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，未命中强制文档映射规则。

## decisions

- 在既有候选过滤入口按站点限制目标 slug；不改 Soul 数据与持久化状态。

## scan_scope

- `frontend/src/pages/marketing/agent-buddy-*`、相邻 `__tests__`、`frontend/openspec/specs/buddy.md`。

## scan_output

- 有界搜索确认抽卡、重抽、测试共用 `souls` 候选，历史卡另用 `sourceSouls`。

## handoff

- 当前阶段：实现与验证完成，变更暂存供审阅；尚未提交、推送或发布。
