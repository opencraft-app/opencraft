## goal
让“最近执行”中的投递失败和其他长状态信息清晰可读。

## non_goals
- 不改变 Hermes 调度、执行、投递和状态写入逻辑。
- 不提交、发布或修改线上任务。

## requirement_ids / requirement_refs / requirement_excerpt
- 2026-10-10 用户截图反馈：定时任务最近执行的英文报错在红框中占据整行，展示混乱。
- 2026-10-10 用户补充：悬停“通知未送达”时展示报错信息。

## interface_refs / data_structure_refs
- `frontend/src/lib/hermes-cron-client.ts` 的 `CronRunRecord.status` 保留 Hermes 状态原文；列表展示不得覆盖它。
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 的 `RecentCronRunsPanel` 与详情弹窗共用展示状态。

## history_context
- `current_design_refs`: `frontend/openspec/specs/marketing.md`；`docs/engineering/domains/site-environment-routing.md`。
- `relevant_evolution`: 最近执行已支持查看该次 Markdown 结果；任务执行状态和投递状态可能不同。

## acceptance
- 投递失败列表显示简短状态且保留任务名称、时间；详情解释执行与投递的区别，并可展开原始状态。
- 悬停或聚焦“通知未送达”可查看原始报错；浮层脱离列表裁剪区域，文本可以选中复制。
- 未知长状态不直接进入徽标；已有成功、失败、未执行、执行中展示不回归。
- 国内站和国际站启用语言翻译通过；前端检查、测试、构建门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-automations-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-automations-panel.test.ts`
- `frontend/src/i18n/generated/`
- `docs/engineering/domains/site-environment-routing.md`

## required_context
- `frontend-product-surface`；前端服务 Context、服务级 AGENTS、DESIGN、OpenSpec、i18n 邻接卡。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@HEAD` | 路由必读 | 确定前端验证边界 |
| `frontend/AGENTS.md@HEAD` | 服务规则 | 确定 UI、翻译和门禁要求 |
| `frontend/DESIGN.md@HEAD` | 样式修改 | 保持现有卡片和详情布局 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | 邻接卡 | 检查 OpenSpec、翻译生成与相邻测试 |
| `frontend/openspec/specs/marketing.md@HEAD` | 当前设计 | 保留最近执行结果入口 |
| `docs/engineering/domains/site-environment-routing.md@HEAD` | 正式设计 | 记录双站状态展示规则 |

## evidence
- `rg` 定位到 `formatLastStatus` 对未知状态原样返回，状态徽标因此被长错误撑开。
- 双站自动任务组件测试 210/210 通过；`pnpm check` 和 `pnpm build` 通过。
- 补充悬停交互后，相关组件测试 202/202、`pnpm check`、`pnpm build` 通过；本地示例预览确认浮层显示于卡片外，截图已保存。
- 全量 `pnpm test` 出现多个其他模块失败及进程内存耗尽，已停止；OpenCraft 只读同步检查报告本轮更改导致的生成副本漂移。

## risks
- Hermes 状态可能新增格式；未知值显示短状态并在详情保留原文，可回退前端展示逻辑。

## validation
- 聚焦组件测试；`pnpm check`、`pnpm test`、`pnpm build`；OpenCraft 同步只读检查；`validate_change_impact.py --staged`。

## decisions
- 只调整展示层，保留原始 `CronRunRecord.status`，不改变调度记录解析。

## scan_scope
- `frontend/src/pages/marketing/agent-automations-panel.tsx` 与相邻测试、`frontend/src/lib/hermes-cron-client.ts`。

## scan_output
- 无独立扫描产物。

## handoff
- 本地独立工作区完成实现；按 `frontend/AGENTS.md` 先提交前端真源，再在独立提交中同步 OpenCraft 生成副本。提交 MR 不代表合并或发布。
