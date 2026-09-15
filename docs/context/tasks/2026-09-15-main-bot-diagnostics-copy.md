# 主 Bot 诊断中心副标题恢复

## goal
主 Bot 的诊断中心恢复多 Bot 上线前的副标题，普通 Bot 保持现有引导文案。

## non_goals
- 不调整日志命令、维护操作权限、Bot/Profile 路由或页面布局。
- 不提交、推送、创建 MR、发布或变更生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-15）：主 Bot 的日志位置改回原来的旧文案。

## interface_refs / data_structure_refs
- `AgentDiagnosticsPanel.isMainBot`：沿用现有主 Bot 判定，不新增状态或接口。

## history_context
- `current_design_refs`：`frontend/openspec/specs/marketing.md`。
- `relevant_evolution`：`c43e86592e821ba393558a1945f1eeb4e8d40c05` 将统一旧文案改为多 Bot 引导文案。
- `superseded_refs`：旧文案仅恢复给主 Bot，不恢复为所有 Bot 的统一文案。

## acceptance
- 主 Bot 显示“查看 Hermes Agent 日志，并集中执行相关维护操作”。
- 普通 Bot 显示“查看当前 Bot 的日志；Agent 级维护请在主 Bot 中操作”。
- 聚焦组件测试与前端 i18n/check 门禁通过。

## affected_paths
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/i18n/generated/*.json`

## required_context
- Pack：`frontend-product-surface`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@cf3308ef` | 前端服务边界 | 确认聚焦测试与 i18n 验证要求 |
| `frontend/AGENTS.md@cf3308ef` | 最近服务级规则 | 约束最小修改和前端门禁 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@cf3308ef` | 前端 i18n 邻接 | 确认生成字典和相邻测试 |
| `frontend/openspec/specs/marketing.md@cf3308ef` | 诊断中心当前规格 | 保持页面入口和双站显隐不变 |
| `docs/context/tasks/2026-09-10-multi-bot-diagnostics.md@cf3308ef` | 多 Bot 诊断历史 | 保持主/普通 Bot 的操作边界不变 |

## evidence
- 开发起点：`cf3308ef2ce9c911d4835157ba7e6aba82dc402b`；提交 MR 前目标分支已前进至 `4216ff19773c246d2f7a05fd93abfe9af70058cd`，交付提交需变基到最新目标。
- Git 历史确认旧文案及其原有多语言翻译键为 `k_a6c56cad`。
- 主/普通 Bot 条件文案由同一个多 Bot 渲染测试覆盖，8 个测试通过。

## risks
- 风险：条件写反导致普通 Bot 丢失主 Bot 操作引导。
- 缓解：同一渲染测试覆盖主 Bot 与普通 Bot 两个分支。

## validation
- `pnpm exec vitest run src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`：8/8 通过。
- `pnpm check`：通过；TypeScript 174 个现存诊断、276 baseline、0 新增。
- i18n：6 个字典均收录旧文案；必填语种无新增空译文，繁中转换检查通过。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`：通过，无命中规则或 owner review 要求。
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`：通过，0 个 first-party 断链。
- `git diff --check`：通过。

## decisions
- 直接复用 `isMainBot` 做双分支文案，不增加辅助函数或新组件。
- 恢复旧文案已有翻译，不引入新的翻译措辞。

## scan_scope
- `frontend/src/pages/marketing/agent-diagnostics-panel.tsx`
- `frontend/src/pages/marketing/__tests__/agent-diagnostics-multi-bot.test.tsx`
- `frontend/src/i18n/generated/`

## scan_output
- 有界搜索确认旧文案当前不在源码/字典，新文案只在诊断面板中使用。

## handoff
- 实现与本地验证完成。隔离 worktree：`/Users/pablozhong/codex/lightvela-main-bot-diagnostics-copy`；交付分支：`codex/main-bot-diagnostics-copy`。本次已获 commit、push 和创建 MR 授权；最终状态以远端复核为准。
