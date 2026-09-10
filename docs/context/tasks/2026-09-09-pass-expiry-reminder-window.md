## goal
把 Agent 管理台套餐到期提醒从剩余 7 天内显示调整为剩余 5 天内显示，避免新注册 7 天体验用户立即看到到期提醒。

## non_goals
- 不调整套餐有效期、续费流程、计费状态推断或弹窗交互。
- 不修改中文及其他非英文文案。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：七天体验注册后马上提示到期，改成提前 5 天提示。

## interface_refs / data_structure_refs
- `frontend/src/lib/pass-renewal.ts#getPassExpiryReminder`：仅 active pass 且到期时间有效时返回提醒对象。

## history_context
- `current_design_refs`：`docs/context/project/services/frontend.md`、`frontend/AGENTS.md`。
- `relevant_evolution`：unknown。
- `superseded_refs`：none。

## acceptance
- 剩余 5 天时显示 day-level 到期提醒。
- 剩余 6 天时不显示到期提醒。
- 原有 1 天内 urgent 提醒保持不变。
- 国际站到期标签使用 `Expires soon`，并在 Agent 侧栏保持单行显示。

## affected_paths
- `frontend/src/lib/pass-renewal.ts`
- `frontend/src/lib/__tests__/pass-renewal.test.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/pages/marketing/__tests__/agent-settings-renewal-reminder.global.test.tsx`
- `frontend/src/styles.css`
- `frontend/src/i18n/generated/en-US.json`

## required_context
- Pack：`frontend-product-surface`
- 预期权威文件：`docs/context/project/services/frontend.md`、`frontend/AGENTS.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | 前端产品 UI 变更路由 | 确认服务边界和最小验证要求 |
| `frontend/AGENTS.md` | 最近前端上下文入口 | 确认前端命令和硬规则 |
| `/Users/pablozhong/.codex/skills/karpathy-guidelines/SKILL.md` | 仓库要求代码改动使用该 skill | 保持改动手术式且可验证 |
| `.agents/skills/gongfeng/SKILL.md` | 用户要求提交 MR | 按工蜂 MCP 规则创建 MR |

## evidence
- `cd frontend && pnpm vitest run src/lib/__tests__/pass-renewal.test.ts`：1 个测试文件通过，4 个用例通过。
- 英文标签改为 `Expires soon`，胶囊设置 `white-space: nowrap`；到期提醒与侧栏聚焦回归 43 个用例通过，`pnpm check` 通过且 TypeScript 无新增诊断。

## risks
- 风险：阈值收紧后，剩余 6-7 天的用户不再看到续费入口提醒。
- 缓解：只改提醒窗口，不改续费入口和套餐状态。

## validation
- `cd frontend && pnpm vitest run src/lib/__tests__/pass-renewal.test.ts`

## decisions
- 将提醒窗口固定为 5 天，直接替换原 7 天窗口；owner：Codex 本轮执行。

## scan_scope
- `frontend/src/lib`
- `frontend/src/pages/marketing/__tests__`

## scan_output
- `rg` 定位到提醒逻辑在 `frontend/src/lib/pass-renewal.ts`，相关 helper 单测在 `frontend/src/lib/__tests__/pass-renewal.test.ts`。

## handoff
- 当前状态：提醒窗口已改为 5 天，聚焦单测通过。
- 下一步：提交 MR 后跟踪 CI 与 mergeability。
