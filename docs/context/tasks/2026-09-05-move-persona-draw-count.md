---
id: move-persona-draw-count-2026-09-05
type: task
scope: 将人设页已抽卡片数量标签移动到人设卡片标题后。
status: ready-for-review
owner: wisp/mono2-maintainers
---

## goal

把“已抽 x/8”从底部操作区移动到“人设卡片”标题后紧邻展示，并保持桌面与窄屏布局清晰。

## non_goals

- 不修改抽卡上限、抽卡状态、持久化或注入行为。
- 不修改“人设卡片”“已抽”文案及翻译。
- 不提交 MR、不合并、不发布。

## requirement_ids / requirement_refs / requirement_excerpt

- 用户截图反馈（2026-09-05）：红框内“已抽 xxx”标签挪到上方，放在“人设卡片”文案后展示。

## interface_refs / data_structure_refs

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`：`BuddyPanel`、`ProgressChip`。
- 不变量：Chip 只在 `drawnSouls.length > 0` 时展示，数值继续使用 `drawnSouls.length / MAX_DRAWS`。

## history_context

- `current_design_refs`：`frontend/openspec/specs/buddy.md`。
- `relevant_evolution`：人设卡片标题与 SkillHub 来源已位于面板 toolbar；本次只调整计数 Chip 的展示层级。
- `superseded_refs`：无。

## acceptance

- 有已抽卡片时，“已抽 x/8”与“人设卡片”位于同一标题组，且紧随标题。
- 底部操作区不再渲染或预留进度标签。
- 无已抽卡片时不显示进度标签。
- 小容器下标题组和 SkillHub 来源不重叠。
- 聚焦测试、`pnpm i18n:check`、`pnpm check`、`git diff --check` 通过。

## affected_paths

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/styles.css`
- `frontend/openspec/specs/buddy.md`
- `docs/context/tasks/2026-09-05-move-persona-draw-count.md`

## required_context

- `frontend-product-surface`
- `service-frontend`
- `site-environment-routing`
- `adjacency-frontend-runtime-openspec-i18n`

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@1878ce679` | 前端硬规则与验证门禁 | 约束实现与测试 |
| `docs/context/project/services/frontend.md@1878ce679` | 前端 UI 服务边界 | 确认聚焦测试与视觉验证要求 |
| `docs/context/domains/site-environment-routing.md@1878ce679` | 双站边界 | 保持共享人设页区域行为一致 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1878ce679` | 实现、规格、i18n 与测试邻接 | 检查相邻测试与规格同步 |
| `frontend/openspec/specs/buddy.md@1878ce679` | Buddy 当前正式规格 | 保持抽卡状态与上限不变 |

## evidence

- 当前源码确认 `ProgressChip` 位于 `.lv-buddy-panel__actions` 内，通过绝对定位展示在底部右侧。
- RED：新增标题邻接断言后，旧结构因标题父级仍为 toolbar 而失败。
- GREEN：`agent-buddy-panel.test.tsx` 34/34 通过，覆盖有卡时标题邻接、底部移除及无卡时不显示。
- `pnpm check` 通过：i18n 结构错误 0、既有告警 48，TypeScript 相对基线 0 个新增诊断。
- 本地 `/agents/persona/` 返回 200；当前本地会话进入“立即创建”空状态，未取得真实 Agent 人设盘截图。

## risks

- 风险：标题、计数和 SkillHub 来源在窄屏重叠。缓解：窄容器下让 toolbar 分行并取消来源链接绝对定位。
- 回滚：回退本次 JSX、CSS、测试与规格的局部改动。

## validation

- [x] 聚焦 `agent-buddy-panel.test.tsx`：34/34。
- [x] `pnpm i18n:check`（由 `pnpm check` 覆盖）。
- [x] `pnpm check`。
- [x] `git diff --check` 与 change-impact 门禁。
- [x] 窄容器规则检查：标题/计数保持同组，SkillHub 来源取消绝对定位并独占下一行。
- [ ] 真实 Agent 桌面/窄屏截图；本地会话缺少 Agent，列入后续预览或发布回归。

## decisions

- 复用现有 `ProgressChip`，不新增状态或组件。
- 标题与 Chip 使用同一个 inline flex 容器；SkillHub 链接保持 toolbar 邻居。

## scan_scope

- `frontend/src/pages/marketing/agent-buddy-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-buddy-panel.test.tsx`
- `frontend/src/styles.css`
- `frontend/openspec/specs/buddy.md`

## scan_output

- 精确搜索确认进度 Chip 仅在 BuddyPanel 主操作区渲染一次，移动后无需处理其他调用点。

## handoff

- 当前状态：实现和前端门禁完成，待代码审阅；尚未 commit、push、创建 MR 或发布。
- 下一步：完成 change-impact 与最终范围检查，获得用户单独授权后再提交 MR。
- 阻塞项：无。
