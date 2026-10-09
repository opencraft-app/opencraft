## goal
从 Agent 页左下角账号菜单打开云存储弹窗，在当前页面完成文件查看与管理。

## non_goals
- 不改变云存储文件 API、权限和文件操作语义。
- 不删除已有 `/agents/files` 直达页面。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户 2026-10-08 请求及截图：点击左下角云存储后，在浏览器当前页面弹窗内操作、管理、查看云存储。

## interface_refs / data_structure_refs
- `SidebarUserMenu` 的 files 入口；`TatFileManagerPanel` 的 `botId`；当前 Agent 页的 `activeBot.id`。
- 弹窗必须绑定当前 Bot，关闭后保留原页面和 URL。

## history_context
- current_design_refs: `frontend/DESIGN.md` 的 Modal Layout；`frontend/openspec/changes/2026-09-02-cloud-storage-capacity-implementation-plan.md` 的容量展示约束。
- relevant_evolution: 文件管理已集中在 `TatFileManagerPanel`，路由页为 `/agents/files`。
- superseded_refs: 无。

## acceptance
- 左下角菜单点击云存储时，当前 Bot 的文件管理器在弹窗中呈现，URL 不变；可通过 Esc 或关闭按钮返回原页面。
- 文件浏览、上传、下载、重命名、删除沿用现有面板。
- `/agents/files` 已有文件面板时不再打开第二个面板；文件面板只认领自身触发的下载请求。
- 聚焦组件测试、`pnpm check`、`pnpm test`、`pnpm build` 及 OpenCraft 同步只读检查。

## affected_paths
- `frontend/src/components/site/sidebar-user-menu.tsx`
- `frontend/src/components/site/sidebar-user-menu-controller.tsx`
- `frontend/src/components/site/user-avatar-menu.tsx`
- `frontend/src/components/domain/tat-file-manager-panel.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- 对应组件测试。

## required_context
- frontend-product-surface、service-frontend、site-environment-routing。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/project/services/frontend.md@worktree` | 前端服务边界 | 确认验证门禁 |
| `docs/context/domains/site-environment-routing.md@worktree` | 双站共用入口 | 保持国内与国际站一致 |
| `frontend/AGENTS.md@worktree` | 最近服务规则 | 组件复用及同步门禁 |
| `frontend/DESIGN.md@worktree` | 弹窗设计 | 结构与可访问性 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@worktree` | 邻接测试 | 检查 OpenSpec 与组件测试 |
| `frontend/openspec/changes/2026-09-02-cloud-storage-capacity-implementation-plan.md@worktree` | 现有功能约束 | 复用容量与文件管理逻辑 |
| `docs/context/flows/tapd-gongfeng-delivery.md@worktree` | 最新 master 冲突处理与 MR 交付 | 核对提交及远端验证门禁 |
| `docs/context/flows/change-delivery.md@worktree` | 交接流程 | 更新任务证据与 checkpoint |
| `opencraft/AGENTS.md@worktree` | 生成副本边界 | 清单由同步脚本生成 |

## evidence
- 路由器命中以上 3 个 Pack；精确搜索定位账号菜单、Agent 页和文件管理面板。
- `pnpm check` 通过：TypeScript diagnostics 166 current / 171 baseline / 0 new。
- 使用临时测试配置把 Vitest host 和 jsdom URL 设为 `127.0.0.1` 后，账号菜单、云存储面板 3 个文件共 71 个测试通过；临时配置已删除。
- `pnpm build` 通过，Next.js 生成 106 个静态页面；构建生成的 `next-env.d.ts` 和字体文件已恢复。
- 完整 Vitest 门禁启动后，模型配置测试出现 84 个失败；单测复现为本机 Python 缺少 `cryptography`，与此次修改路径无关，随后停止完整门禁。
- `npm --prefix opencraft run check:mono2-agent-console` 报文件管理面板生成副本漂移；按 `frontend/AGENTS.md` 须先提交真源，再生成带正确 sourceRevision 的副本。
- `validate_documentation.py --repo . --format json` 通过，broken links 0、warnings 0；`git diff --check` 通过。
- CR !5104 修复：合入 `origin/master` 后保留双方账号菜单逻辑；双面板下载归属与删除中守卫相关组件测试 58/58 通过，`pnpm check`、`pnpm build:cn`、文档校验与变更影响检查通过。
- 2026-10-09 再合入 `origin/master`（`50aadd48b`）：仅 OpenCraft `UPSTREAM.json` 的 `sourceRevision` 文本冲突；前端代码自动合并，云存储入口仍绑定当前 Bot。合并树上 `pnpm check` 0 新增 TypeScript 诊断、相邻 4 个测试文件 99/99 通过、`pnpm build:cn` 通过。生成清单待源提交后按脚本同步。
- 本轮全量 Vitest 单 worker 在出现既有模型配置等失败后停止，未获得全量通过结果；OpenCraft 文件面板副本将在真源提交后同步。

## risks
- 弹窗内容较长：使用限高与独立纵向滚动；已有直达页提供回退入口。
- 当前 Bot 不存在时保留原路由链接。
- 同 Bot 的多个文件面板监听同一 SW 下载消息，需按本面板创建的下载触发器限定认领范围。

## validation
- 聚焦组件测试、`pnpm check`、`pnpm build` 通过；完整测试受本机 Python 依赖阻断，OpenCraft 同步检查将在源码提交后复检。

## decisions
- 复用 `TatFileManagerPanel` 和现有 Dialog；页面直达路由保留。
- CR !5104 后续：`/agents/files` 菜单保留直达链接，文件面板用已有 iframe 触发器记录远端路径以限定 SW 下载请求归属，不改 Service Worker 协议。

## scan_scope
- `frontend/src/components/site/`、`frontend/src/components/domain/tat-file-manager-panel.tsx`、`frontend/src/pages/marketing/agent-settings-page.tsx`。

## scan_output
- `rg` 精确命中摘要已体现在 `evidence`。

## handoff
- 源码与组件测试已完成，位于隔离工作树；用户已授权提交 MR。
- 提交 frontend 真源后，运行 OpenCraft 同步脚本、提交生成副本并重新检查；完整测试须先补齐本机 Python `cryptography` 或在具备依赖的 CI 中执行。
