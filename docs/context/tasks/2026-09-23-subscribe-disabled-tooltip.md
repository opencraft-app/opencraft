## goal
为订阅页因已有套餐或 Agent 而置灰的新购按钮增加原因提示。

## non_goals
- 不改变套餐可购买条件、后端确认的升级目标、支付流程或按钮文案。
- 不修改后端、发布或 GitOps。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户截图与本轮需求：置灰的套餐按钮在 hover 时提示原因。

## interface_refs / data_structure_refs
- `SubscribePage` 的 `isSubscribed`、`bots`、`activePass`、`latestPass` 状态。
- `PlanCard` 的现有 `disabled`、`subscriptionLocked` 与 `upgradeTargetIds` 语义保持不变。

## history_context
- `current_design_refs`：`frontend/DESIGN.md`、`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`：当前订阅页在已有权益或 Agent 时锁定新购 CTA，并按后端目标开放升级，但锁定状态缺少原因提示。
- `superseded_refs`：无。

## acceptance
- 因已有套餐或 Agent 锁定时，新购 CTA 仍不可点击。
- 后端确认的升级目标继续可用，不展示新购锁定提示。
- 鼠标悬停或键盘聚焦 CTA 外层时显示已有套餐原因。
- Tooltip 通过 Portal 脱离套餐卡的 `overflow: hidden`，支持 Escape 关闭。
- 售罄、即将上线、询价中、暂无报价等已有明确文案的状态不叠加该提示。

## affected_paths
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`
- `frontend/src/pages/marketing/agent-model-config/model-action-tooltip.tsx`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- 初始路由查询 `frontend subscribe page disabled plan button hover reason tooltip accessibility` 未命中 Pack；已按规则执行有界精确搜索。提交前用 `frontend subscribe disabled CTA tooltip existing subscription` 复核，命中 `subscription-entitlements` Pack。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@d4c130622` | 仓库硬边界 | 限定修改、验证与交付权限 |
| `frontend/AGENTS.md@d4c130622` | 最近服务规则 | 确认前端门禁与视觉回归要求 |
| `frontend/DESIGN.md@d4c130622` | Tooltip 规范 | 采用 Portal、hover/focus、可复制内容与短关闭缓冲 |
| `docs/context/domains/subscription-entitlements.md@d4c130622` | 订阅与权益 Domain Pack | 保留后端权威订阅、升级目标与前端展示边界 |
| `docs/context/tasks/TASK-TEMPLATE.md@d4c130622` | Task Pack 模板 | 记录任务状态与证据 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@d4c130622` | 前端邻接检查 | 核对实现、相邻测试与既有 i18n 文案 |
| `frontend/src/pages/marketing/agent-model-config/model-action-tooltip.tsx@d4c130622` | 既有 Tooltip 原语 | 复用 Portal、定位、键盘与 Escape 行为 |

## evidence
- 聚焦 Vitest：`subscribe-page.test.tsx`、`subscribe-page.global.test.tsx`、`model-action-tooltip.test.tsx` 共 73 个用例通过。
- `pnpm check` 通过：i18n、繁简、文档同步和 TypeScript baseline 均无新增错误。
- `pnpm build` 与 `pnpm build:global` 均通过，覆盖国内站和国际站静态产物。
- `validate_documentation.py --format json` 通过：0 个断链、0 个错误。
- 干净 `origin/master` 对照确认升级报价竞态用例在 CTA 包装节点切换时失败；使用稳定包装节点后，该用例与新增 Tooltip 用例均通过。
- 全量 Vitest 在无关的模型配置、Automation、文档内容等既有套件出现大范围失败并长时间不退出，已中止；本变更相关聚焦套件全绿。

## risks
- 风险：禁用按钮本身不触发 hover/focus。缓解：复用包裹式 Tooltip 触发器。
- 风险：Tooltip 被套餐卡裁剪。缓解：复用 `document.body` Portal。
- 风险：误锁升级入口。缓解：Tooltip 和禁用原因只应用于非 `isUpgradeTarget` 的新购 CTA。
- 风险：修改 i18n 生成物。缓解：复用已有“你已订阅…”翻译键，不新增文案。

## validation
- 聚焦 Vitest：订阅页国内/国际测试与 Tooltip 原语测试。
- `pnpm check`。
- `git diff --check` 与 staged change-impact 检查。

## decisions
- 只为全局新购锁定补充原因提示；升级目标与已有自解释文案的禁用态保持原样。
- 复用已有 `ModelActionTooltip`，不新增第二套 Tooltip 交互实现。

## scan_scope
- `frontend/next-site/subscribe-page.tsx`
- `frontend/next-site/__tests__/subscribe-page.test.tsx`
- `frontend/src/pages/marketing/agent-model-config/model-action-tooltip.tsx`

## scan_output
- 无独立扫描产物。

## handoff
- 实现与门禁完成，待本地提交；未推送、未创建 MR、未发布。
