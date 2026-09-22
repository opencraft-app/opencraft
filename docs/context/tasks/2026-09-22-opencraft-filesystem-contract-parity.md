---
id: opencraft-filesystem-contract-parity
type: task
scope: Align local Agent Host filesystem RPC responses with the generated AppServer v2 contract.
triggers: ["file URL localeCompare", "local Agent Host filesystem"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-filesystem-contract-parity.md
status: complete
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.1
precedence: task
derived: false
---

## goal
修复 Codex 会话点击本地 `file://` 资源后资源面板在目录排序阶段读取 `undefined.fileName` 的崩溃，并把文件系统返回结构统一到生成的 AppServer v2 contract。

## non_goals
- 不在 UI 排序器中吞掉非法目录项。
- 不修改 Codex 官方 AppServer 协议或文件内容。
- 不发布生产或替换安装包。

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-protocol/src/generated/v2/FsReadDirectoryEntry.ts`
- `opencraft/packages/appserver-protocol/src/generated/v2/FsGetMetadataResponse.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- 不变量：Host/Bridge 在传输边界完成协议投影；Workbench 只消费生成 contract。

## acceptance
- `fs/readDirectory` 返回 `{fileName,isDirectory,isFile}`，不再返回 `{name,path,type}`。
- `fs/getMetadata` 返回毫秒时间及 file/directory/symlink 布尔字段。
- Local Agent Host 聚焦测试、类型检查和 change-impact 通过。

## affected_paths
- `opencraft/apps/local-agent-host/src/main.ts`
- `opencraft/tests/local-agent-host.test.ts`
- Agent runtime 正式设计文档。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库、提交和验证边界 | 合入前必须有新证据 |
| `opencraft/AGENTS.md@working-tree` | Host/Workbench 所有权 | 禁止 UI 私有兼容 |
| `opencraft/packages/appserver-protocol/src/generated/v2/FsReadDirectoryEntry.ts@working-tree` | 生成协议权威 | 目录项结构 |
| `opencraft/packages/appserver-protocol/src/generated/v2/FsGetMetadataResponse.ts@working-tree` | 生成协议权威 | metadata 结构 |
| `ref/codex/editor/check-index-file-exists-04793.ts@66a586468` | Codex 调用方参考 | 确认官方消费 `fileName` |

## evidence
- 本机 Codex CLI `0.155.1` 直接 schema probe 确认官方 `fs/readDirectory` 返回 `{fileName,isDirectory,isFile}`。
- `npm exec -- tsx --test tests/local-agent-host.test.ts`：12/12 通过，新增文件系统 contract 回归用例。
- `npm run test:appserver`：203/203 通过。
- `npm run typecheck --workspace @opencraft/local-agent-host` 与 `git diff --check` 通过。
- `validate_change_impact.py` 对精确变更集通过；仍要求 `wisp/mono2-maintainers` owner review。

## decisions
- 修复位于 `local-agent-host` 的协议投影边界，不在 `workspace-resource-panel` 增加空值 fallback。
- 同步纠正相邻的 `fs/getMetadata` 旧结构，避免文件读取链下一阶段再次发生 schema drift。

## handoff
- 修复完成；提交、推送和合入状态由本次交付流程继续记录。
