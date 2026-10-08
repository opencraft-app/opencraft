## goal
删除云存储中的文件或文件夹前，明确提示目标名称与不可恢复风险，并要求二次确认。

## non_goals
- 不改变 TSSH 删除 API、目录非空处理或文件权限。
- 不修改其他产品的删除流程。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-08 请求：“删除文件、文件的时候，增加一个弹窗强提醒”；按文件与文件夹的删除操作理解。

## interface_refs / data_structure_refs
- `TatFileManagerPanel` 的 `selectedFile` 与 `TencentTsshFileClient.deleteFile(path, isDirectory)`；确认前不得调用删除。

## history_context
- current_design_refs: `frontend/DESIGN.md` Modal Layout；现有 `DeepSeekHarnessProviderDeleteDialog` 的危险操作交互。
- relevant_evolution: 当前云存储弹窗与 `/agents/files` 页面复用 `TatFileManagerPanel`，删除按钮直接调用 `deleteSelected`。
- superseded_refs: 无。

## acceptance
- 文件与文件夹均显示待删除名称和不可恢复提醒；取消或关闭不删除，确认才调用原 API。
- 删除中防止重复提交；失败时提示错误并允许取消或重试。
- 聚焦组件测试、前端检查和 OpenCraft 同步检查通过，并在本地预览确认嵌套弹窗。

## affected_paths
- `frontend/src/components/domain/tat-file-manager-panel.tsx`
- `frontend/src/components/domain/__tests__/tat-file-manager-panel.test.tsx`

## required_context
- 路由器没有命中 Pack；按规则执行相关目录的有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@worktree` | 前端规则 | 复用 Dialog、验证和同步门禁 |
| `frontend/DESIGN.md@worktree` | 弹窗规范 | 提醒弹窗结构与焦点行为 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@worktree` | 前端邻接卡 | 检查 OpenSpec 与相邻测试 |
| `frontend/openspec/changes/2026-09-02-cloud-storage-capacity-implementation-plan.md@worktree` | 云存储约束 | 删除成功后仍刷新容量 |

## evidence
- `validate_context.py --route 'frontend cloud storage file manager delete file folder confirmation dialog'` 未命中 Pack；在 `frontend/src/components/domain/` 精确搜索命中 `deleteSelected` 与其组件测试。
- 现有删除路径直接调用 `deleteFile`，无确认步骤。
- 聚焦组件测试 35/35 通过；覆盖取消、文件与文件夹确认、失败后重试和容量刷新。
- 本地国内站预览已显示嵌套确认弹窗；取消后焦点返回原删除按钮，未调用真实删除。
- `pnpm check` 通过，TypeScript diagnostics 0 new；`git diff --check` 通过。
- OpenCraft 只读检查按预期发现真源变更导致的副本漂移，需在真源提交后生成同步提交。

## risks
- 嵌套在云存储弹窗中时确认 Dialog 的焦点与遮罩必须正常；在本地预览验证。

## validation
- 聚焦组件测试、`pnpm check` 已通过；待运行 `pnpm build` 与真源提交后的 OpenCraft 同步检查。

## decisions
- 在共享文件管理面板加入确认 Dialog，使弹窗和直达页面使用同一保护；沿用现有删除 API。

## scan_scope
- `frontend/src/components/domain/`、相关 OpenSpec、相邻组件测试。

## scan_output
- 精确命中 `tat-file-manager-panel.tsx:931` 的 `deleteSelected` 及相邻测试。

## handoff
- 实现、验证、同步与 MR 更新进行中。
