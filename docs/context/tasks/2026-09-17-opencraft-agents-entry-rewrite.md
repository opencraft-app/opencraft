## goal
把 `opencraft/AGENTS.md` 重构为短、可执行、按任务渐进加载的局部 Agent 入口，同时保留 OpenCraft 的安全、生成、预览和真实客户端验收边界。

## non_goals
- 不复制 BB 的产品、CLI、数据库或 Turbo 专用规则。
- 不改变 OpenCraft 运行时代码、发布或生产状态。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户要求深入参考 `ref/bb`，评估并实施 OpenCraft Agent 入口优化。

## interface_refs / data_structure_refs
- mono2 根 `AGENTS.md`：上级规则与 Context Router。
- `opencraft/AGENTS.md`：仅提供 OpenCraft 相对根入口的局部增量。

## history_context
- `current_design_refs`：根 `AGENTS.md`、`opencraft/docs/platform-architecture.md`、`opencraft/docs/build-matrix.md`。
- `relevant_evolution`：原入口包含正确但高密度的 UI Preferences、视觉原则和预览正文；`ref/bb/AGENTS.md` 采用任务类型分组和单一可执行规则。
- `superseded_refs`：旧版 `opencraft/AGENTS.md` 仅通过 Git diff 保留。

## acceptance
- 入口低于 8 KiB，明确继承、authority 与按需加载。
- 补齐完成标准、代码 contract、UI 分层和验证矩阵。
- 保留 Web、Electron 当前源码与 macOS 打包预览方法。
- 文档链接检查与 diff check 通过。

## affected_paths
- `opencraft/AGENTS.md`

## required_context
- 根 `AGENTS.md` 与 `context-audit` 文件契约。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | 当前局部入口 | 确认保留的硬边界与需下沉的正文 |
| `ref/bb/AGENTS.md@current-pin` | 用户指定参考 | 提取任务分组和可执行规则写法 |
| `.agents/skills/context-audit/references/document-contracts.md@current` | Agent 入口契约 | 约束局部入口只写根规则增量 |
| `.agents/skills/context-audit/references/repository-structure.md@current` | 指令预算与职责 | 检查 8 KiB 目标和渐进加载 |

## evidence
- `opencraft/AGENTS.md` 为 7,537 bytes，低于局部入口 8 KiB 目标。
- `validate_documentation.py --repo . --format json`：0 errors、0 broken links。
- `git diff --check`：通过。

## risks
- 过度压缩会丢失用户明确要求的预览方法；三种预览入口保留在表格中。
- 复制 BB 规则会引入不适用约束；仅借鉴组织方式，未迁入 CLI、Drizzle、Turbo 或禁注释规则。

## validation
- 文档链接与分类校验。
- 文件大小、正文读回与 Git diff check。

## decisions
- 深层 UI Preferences 实现下沉为正式架构链接，只在入口保留 ownership 不变量。
- 用责任表和验证矩阵代替高密度复句。
- 保留 OpenCraft 特有的生成闭包、隔离预览和真实客户端证据规则。

## scan_scope
- `opencraft/AGENTS.md`
- `ref/bb/AGENTS.md`
- `ref/bb/CLAUDE.md`
- OpenCraft 正式架构、构建矩阵与 Context 入口契约。

## scan_output
- 无独立扫描产物。

## handoff
- 重写与文档验证完成；未提交、推送或发布。
