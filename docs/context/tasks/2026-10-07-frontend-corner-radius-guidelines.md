## goal
将本轮确认的 LightVela 前端圆角规则写入正式设计规范，并让 Codex、Claude Code 与 CodeBuddy 的项目入口指向同一规范。

## non_goals
- 不批量修改现有组件样式，不合并、发布或部署。
- 不把“外层圆角＝内层圆角＋间距”作为通用规则。

## requirement_ids / requirement_refs / requirement_excerpt
- 当前对话（2026-10-07）：用户确认定时任务表单与弹窗、人设页标签与胶囊按钮、通道卡片的圆角，并要求更新前端设计文档和 Agent 指令，最后要求提交 MR。

## interface_refs / data_structure_refs
- 无 API、数据结构或运行时行为变更；仅调整设计与 Agent 指令文档。

## history_context
- `current_design_refs`：`frontend/DESIGN.md` 的 Corner Radius 章节；`docs/engineering/domains/site-environment-routing.md` 的双站前端责任边界。
- `relevant_evolution`：当前 `Card` 默认变体与目标普通信息卡片圆角不同；`pricing` 变体为 12px。设计文档是新增或调整组件的目标，不是现状快照。
- `superseded_refs`：最初参考图中的小标签 4px、输入框 8px、弹窗 16px，以及按嵌套间距推导圆角的建议。

## acceptance
- 规范明确文本输入 6px、常规按钮 8px、普通信息卡片 10–12px、常规弹窗 8px，以及小标签与有意采用胶囊造型的按钮使用全圆角。
- `frontend/AGENTS.md` 明确要求修改前端视觉样式前阅读 `DESIGN.md`；根目录 `CODEBUDDY.md` 引用根目录与前端的 `AGENTS.md`。
- 文档与变更影响校验通过，MR 仅包含本轮相关文件。

## affected_paths
- `CODEBUDDY.md`
- `frontend/AGENTS.md`
- `frontend/DESIGN.md`
- `docs/engineering/domains/site-environment-routing.md`
- `docs/context/tasks/2026-10-07-frontend-corner-radius-guidelines.md`
- `docs/context/tasks/2026-10-07-frontend-corner-radius-guidelines.checkpoint.md`

## required_context
- `site-environment-routing`、`frontend-product-surface`、`service-frontend`、`tapd-gongfeng-delivery`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@working-tree` | 前端域路由 | 确认双站边界 |
| `docs/context/project/services/frontend.md@working-tree` | 前端服务路由 | 确认文档与验证边界 |
| `docs/context/flows/tapd-gongfeng-delivery.md@working-tree` | MR 交付路由 | 确认交付门禁 |
| `frontend/AGENTS.md@working-tree` | 最近服务级指令 | 确认前端约束 |
| `frontend/DESIGN.md@working-tree` | 当前视觉规范 | 修订 Corner Radius 章节 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 前端邻接卡 | 检查相邻源码与测试 |
| `frontend/src/components/ui/card.tsx@working-tree` | 卡片实现 | 区分目标规范与当前默认样式 |
| `frontend/src/components/ui/__tests__/card.test.tsx@working-tree` | 相邻测试 | 确认既有变体的当前断言 |
| `docs/engineering/domains/site-environment-routing.md@working-tree` | 正式领域文档 | 补充跨站设计规范入口 |
| `.agents/context/change-impact.json@working-tree` | 变更影响映射 | 确认文档同步要求 |

## evidence
- 定时任务表单的输入框与文本框使用 `rounded-md`，按钮与弹窗使用 `rounded-lg`；人设页 Beta 标签和上传按钮使用 `rounded-full`；通道卡片半径变量为 10px。
- 当前 `Card` 默认变体是 `rounded-[1.75rem]`，`pricing` 为 `rounded-[12px]`；本次不批量修改运行时组件。
- 文档校验 0 错误、0 警告、0 失效链接；暂存变更影响校验通过。
- `pnpm check` 通过：166 个当前 TypeScript 诊断均在基线内，新增 0 个；`pnpm build` 通过。
- `pnpm test` 在 Vitest 启动前因本机 `localhost` 解析失败退出；没有执行测试用例。

## risks
- 目标规则与部分现有组件圆角不同；后续实际修改相关 UI 时应通过共享变体逐步对齐。
- CodeBuddy IDE 对 `@` 文件引用的展开行为未在本机验证；团队使用时须在新会话检查加载的规则。

## validation
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`
- `git diff --cached --check`
- 前端 `pnpm check`、`pnpm test`、`pnpm build` 按可用环境执行并如实记录。

## decisions
- 按组件角色定义目标圆角，保留定价卡等专用样式；不把现有 `Card` 默认外观误称为已符合目标。
- CodeBuddy 入口只引用现有 Agent 指令，不复制圆角数值。

## scan_scope
- `frontend/DESIGN.md`、相关前端组件源码与相邻测试、映射的工程设计文档。

## scan_output
- 有界检索结果记录在本次任务中；不保存完整扫描产物。

## handoff
- 文档与可运行的前端门禁已校验；测试启动环境故障见 evidence。提交 MR 后仍需依据远端即时状态判断 CI；本任务不合并或发布。
