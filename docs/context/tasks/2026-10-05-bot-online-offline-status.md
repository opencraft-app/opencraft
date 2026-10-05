## goal
Bot 的用户可见生命周期标签从「运行中／已暂停」改为「在线／离线」。

## non_goals
- 不改变后端 `running`、`paused` 状态或 Bot 可用性判断。
- 不改任务执行状态、创建/失败/删除文案和续费提示。
- 不提交或发布。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-05 明确选择：「运行中，搞成在线。已暂停，改成离线」。

## interface_refs / data_structure_refs
- `OpenClawBot.status` 六态定义于 `frontend/src/contexts/agent-context.tsx`；本任务只调整其中两个状态的标签。
- 侧栏 `getBotStatusLabel` 与总览 `FleetBotCard` 独立显示状态文案。

## history_context
- `current_design_refs`：`docs/context/domains/site-environment-routing.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：产品方案讨论后，用户选择简洁的「在线／离线」，替代拟人化长文案。
- `superseded_refs`：无。

## acceptance
- 双站侧栏和 Bot 总览中 `running` 显示「在线」，`paused` 显示「离线」。
- 国际站英文分别显示 `Online`、`Offline`；其他已发布语言有对应译文。
- 状态逻辑、功能门禁和其他状态文案不变。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/agent-fleet-overview.tsx`
- `frontend/src/pages/marketing/__tests__/agent-fleet-overview.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- `validate_context.py --route 'frontend bot lifecycle visible status labels online offline sidebar fleet overview i18n'` 命中 `site-environment-routing`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md` | 双站展示边界 | 保持 locale 一致 |
| `frontend/AGENTS.md` | 服务规则 | 指定门禁与 UI 验证 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md` | i18n 邻接卡 | 查词典生成与测试邻居 |
| `frontend/src/i18n/t.ts` | 词典查找入口 | 使用中文 key 生成翻译 |
| `frontend/src/contexts/agent-context.tsx` | 状态类型 | 保留生命周期语义 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 代码修改规则 | 局部改展示文案 |

## evidence
- 精确搜索定位两个 Bot 状态展示入口，确认原始状态值仍供功能逻辑使用。
- i18n 生成入口新增「在线／离线」键，全部已发布语言补齐译文。

## risks
- 「离线」可能包含套餐到期等多种底层原因；原有 tooltip 继续解释暂停与续费关系，文案不推断单一原因。

## validation
- `pnpm check`
- Bot 总览及 i18n 聚焦测试
- `pnpm build:global`、`pnpm build:cn`
- `git diff --check`、文档和变更影响校验

## decisions
- 改 Bot 专属显示处，不替换「运行中／已暂停」全局翻译，以免自动任务等其他状态被误改。

## scan_scope
- `frontend/src/pages/marketing/` 中 Bot 生命周期标签的精确引用。

## scan_output
- 无独立产物。

## handoff
- 本地改动已验证；未提交、推送或发布。
- Bot 侧栏与总览把 running／paused 显示为「在线」／「离线」，国际站英文显示 Online／Offline。
- 聚焦测试 73 项通过；前端检查、i18n 提取检查、双站构建、diff 空白检查、文档校验与 staged 变更影响校验通过。
- 此工作树同时保留先前任务的未提交改动；未重复运行此前已知会出现无关失败及 worker OOM 的完整前端测试。
