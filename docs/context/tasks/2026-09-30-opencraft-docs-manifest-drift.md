# OpenCraft 清单在文档 MR 中漂移

## goal
让 OpenCraft vendored 清单只跟踪实际同步的 Agent Console 源码，修复文档 MR 的流水线漂移。

## non_goals
- 不改 Agent Console 功能、生产环境或流水线配置。

## requirement_ids / requirement_refs / requirement_excerpt
- MR !4859：国内站与国际站文档能力对齐；用户反馈 `opencraft guard` 的 `sourceRevision` 不匹配。

## interface_refs / data_structure_refs
- `opencraft/scripts/sync-mono2-agent-console.mjs` 的源码闭包、静态资源列表和 `UPSTREAM.json.sourceRevision`。

## history_context
- `current_design_refs`：`opencraft/MONO2_MIGRATION.md`、`docs/context/project/upstream-subtrees.md`。
- `relevant_evolution`：现有脚本以整个 `frontend/src` 查找最新提交，文档提交也会改变 revision。

## acceptance
- 清单与 130 个 vendored 文件通过 `check:mono2-agent-console`。
- 文档改动不推进 vendored revision；实际同步文件改动仍推进 revision。
- MR guard 通过。

## affected_paths
- `opencraft/scripts/sync-mono2-agent-console.mjs`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/UPSTREAM.json`
- `opencraft/MONO2_MIGRATION.md`

## required_context
- `tapd-gongfeng-delivery`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md` | MR 交付边界 | 核对提交和检查状态 |
| `opencraft/AGENTS.md` | 生成层规则 | 使用官方同步脚本 |
| `frontend/AGENTS.md` | 前端真源规则 | 保持文档源文件不变 |
| `opencraft/MONO2_MIGRATION.md` | 同步边界 | 更新 revision 语义 |
| `docs/context/project/upstream-subtrees.md` | 唯一真源 | 保持单向生成 |

## evidence
- 当前文档提交 `0cea6f6da` 曾被写进 manifest；实际 152 个同步路径的最新源码提交是 `2a65b0388`。
- 官方同步脚本仅改 `UPSTREAM.json.sourceRevision`；其余 130 个文件字节未变化。
- 本地 OpenCraft guard 已通过：130 个 vendored 文件一致，142 个嵌入式回归测试通过。

## risks
- 如果实际同步源码更新，必须重新运行官方同步脚本并提交生成物。

## validation
- `npm --prefix opencraft run check:mono2-agent-console`
- `bash .ci/checks/opencraft_guard.sh`
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json`
- `git diff --check`

## decisions
- 用本次实际复制的源码闭包与公共资源作为 Git 历史查询范围，避免无关文档提交触发清单漂移。

## scan_scope
- `opencraft/scripts/sync-mono2-agent-console.mjs`、`.ci/checks/opencraft_guard.sh`。

## scan_output
- 仅 `sourceRevision` 字段发生漂移。

## handoff
- 本地 guard、文档校验和 `git diff --check` 已通过；待提交推送后核对 MR 流水线。
