---
id: task-bot-name-length-limit
type: task
scope: Bot 名称长度限制与创建表单调整。
triggers:
  - bot name length
  - bot creation form
  - profile display name
owner: pablozhong
authority: primary
source_of_truth:
  - ctl/pkg/instance/bots.go
  - frontend/src/pages/marketing/agent-settings-page.tsx
status: active
reviewed_at: 2026-09-10
review_due: 2026-12-10
revision: 1.0.0
precedence: task
derived: false
---

## goal
将实例内 Bot 的名称长度统一限制为最多 60 个字符，并保持前端创建体验与 CTL 创建、重命名校验一致。

## non_goals
- 不修改 Bot 数量限制、Profile ID、创建方式或 Channel 行为。
- 不发布 CTL 或前端；用户后续已授权随主 Bot 删除规则一起提交 MR。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-09-10：Bot 名称限制字符数量，最多 60 个。

## interface_refs / data_structure_refs
- `AgentSettingsPage.handleConfirmCreate`：创建 Bot 前端提交入口。
- `validateInstanceBotText`：CTL 创建 Bot 名称校验。
- `UpdateInstanceBot`：CTL 重命名 Bot 校验。

## history_context
- `current_design_refs`：`docs/engineering/domains/agent-gateway-runtime.md`、`docs/context/tasks/2026-09-09-lightvela-multi-bot-profile.md`。
- `relevant_evolution`：多 Bot 首版将名称写入 Hermes Profile `display_name`，原 CTL 上限为 64。
- `superseded_refs`：无。

## acceptance
- 创建弹窗最多接受 60 个字符，并显示当前字符数与上限。
- 前端提交时对空名称和超过 60 个字符分别给出明确提示。
- CTL 创建和重命名均拒绝超过 60 个 Unicode 码点的名称。
- 前端与 CTL 聚焦测试通过。

## affected_paths
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `frontend/src/styles.css`
- `ctl/pkg/instance/bots.go`
- `ctl/pkg/instance/bots_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `adjacency-frontend-runtime-openspec-i18n`
- `control-plane-ops`
- `agent-gateway-runtime`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | 仓库边界 | 使用独立分支并执行变更门禁 |
| `frontend/AGENTS.md` | 前端局部规则 | 保持类型与聚焦测试要求 |
| `ctl/AGENTS.md` | CTL 局部规则 | 服务端校验作为 API 权威边界 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | 前端邻接 | 检查实现、文案和相邻测试 |
| `docs/context/project/services/ctl.md@2.1.0` | CTL 服务边界 | 创建与更新统一校验 |
| `docs/engineering/domains/agent-gateway-runtime.md` | 多 Bot 正式设计 | 记录长期有效的名称约束 |

## evidence
- 精确搜索确认创建弹窗已有 `maxLength={64}`，CTL 的 `maxInstanceBotNameRunes` 同样为 64。
- 前端创建弹窗改为 `MAX_BOT_NAME_LENGTH = 60`，展示实时计数，并在提交前按 Unicode 码点执行兜底校验。
- “Bot 名称”标签行与输入框间距由 6px 调整为 8px，保持弹窗其余纵向节奏不变。
- 侧栏“新建 Bot”按钮圆角由 6px 调整为 16px；“探索 / 对话”分段控件外框由 8px 调整为 16px、内部选项由 6px 调整为 13px。
- 空白创建提示改为“使用 LightVela 默认配置创建一个独立 Bot。”，以产品品牌替代底层 Hermes 实现名。
- CTL 创建和重命名复用 `validateInstanceBotName`，60 个中文字符通过，61 个返回 `INSTANCE_BOT_INVALID_PARAM` 对应错误。
- 前端侧栏聚焦测试 26/26 通过；完整 `pnpm check` 通过，TypeScript 为 0 个新增诊断，i18n 为 0 error / 51 个既有 warning。
- CTL 名称边界与 Profile 创建命令聚焦测试通过；文档校验、显式 change-impact 和 `git diff --check` 通过。
- 本地 `5174` 的 `/agents/` 返回 HTTP 200；应用内浏览器受本机回环地址策略限制，未取得本轮视觉截图。

## risks
- 前端和 CTL 上限不一致会导致绕过 UI 或错误拒绝；两端同步使用 60，并增加边界测试。
- JavaScript 字符计数与 Go Unicode 码点计数存在 emoji 边界差异；提交校验使用 Unicode 码点计数与 CTL 对齐。

## validation
- `cd frontend && pnpm exec vitest run --config vitest.config.ts --maxWorkers=1 src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `cd ctl && CGO_ENABLED=0 go test ./pkg/instance -run '^TestValidateInstanceBotTextEnforcesNameRuneLimit$' -count=1`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --changed-file ...`
- `git diff --check`

## decisions
- 前端输入框使用原生 `maxLength=60` 并显示计数；提交前再按 Unicode 码点校验。
- CTL 继续作为创建和重命名的最终校验边界，统一将上限从 64 调整为 60。

## scan_scope
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-sidebar-tabs.test.ts`
- `ctl/pkg/instance/bots.go`
- `ctl/pkg/instance/bots_test.go`
- `docs/engineering/domains/agent-gateway-runtime.md`

## scan_output
- 创建弹窗、提交处理和 CTL 共用名称常量均已定位，没有独立 API schema 长度约束。

## handoff
- 实现和验证完成，已纳入 `codex/main-bot-delete-hide-create`，与主 Bot 删除规则一并提交 MR；未发布。
