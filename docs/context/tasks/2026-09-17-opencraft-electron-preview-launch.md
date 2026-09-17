## goal
让 OpenCraft Electron 开发预览始终以 Electron main-process 模式启动，不受父进程 `ELECTRON_RUN_AS_NODE` 污染。

## non_goals
- 不降级 Electron 44。
- 不修改 Renderer、Daemon 的独立 Node-mode 启动语义。
- 不提交、推送、发布或更新生产环境。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求：调查并解决 Electron 预览启动失败；若诊断认知有偏差，同步优化 `AGENTS.md`。

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-electron/package.json` 的 `start` 开发入口。
- `ELECTRON_RUN_AS_NODE=1` 仅属于明确以 Electron 二进制承载 Node 脚本的子进程，不得泄漏到 Electron Main 启动。

## history_context
- `current_design_refs`：`opencraft/docs/build-matrix.md`、`opencraft/AGENTS.md`。
- `relevant_evolution`：Electron 44.1.0 的正常 main-process 对照实验能取得 `app`/`BrowserWindow`；Node mode 可复现模块路径/缺模块现象。
- `superseded_refs`：把 `require("electron")` 返回路径直接判为 Electron 44 回归的诊断。

## acceptance
- 开发启动入口显式移除 `ELECTRON_RUN_AS_NODE`，保留其他环境与额外 Electron 参数。
- 聚焦测试覆盖环境净化与 package script 接线。
- Electron 44 当前源码预览使用隔离 profile 启动并出现 Renderer 页面。
- `opencraft/AGENTS.md` 记录正确的诊断顺序。

## affected_paths
- `opencraft/scripts/start-electron.mjs`
- `opencraft/apps/workbench-electron/package.json`
- `opencraft/tests/electron-preview-launch.test.mjs`
- `opencraft/AGENTS.md`

## required_context
- 根 Context Router 无 Pack 命中，按规则执行了有界精确搜索。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | mono2 边界与 Task Pack/验证要求 | 限定改动与交付 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft 预览纪律 | 选择隔离 profile/端口并更新诊断说明 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | 桌面预览维护方法 | 区分源码、产物、进程和运行证据 |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | 验证清单 | 选择聚焦测试与真实 Electron 验收 |
| `opencraft/docs/build-matrix.md@working-tree` | Electron 构建与预览契约 | 保持 Main/Daemon 模式边界 |

## evidence
- Electron 44.1.0 最小正常 Main 实验：`require("electron")` 返回 API object，`app=true`、`BrowserWindow=true`。
- 父环境显式设置 `ELECTRON_RUN_AS_NODE=1` 后，通过修复后的仓库 `start` 入口启动成功；CDP `9473` 返回 OpenCraft Renderer 页面。
- `npm run test:electron-launch`：4/4 通过。
- `npm run typecheck --workspace @opencraft/workbench-electron`：通过。
- `npm run build:electron`：Renderer、Main、Preload、Daemon 全部构建通过。
- 根 documentation validation、change-impact validation 与目标文件 `git diff --check`：通过。

## risks
- 清理变量不能影响 Daemon 通过 Electron 二进制运行 Node bundle；该变量仍由 `daemon-client.ts` 在子进程局部设置。
- 启动器必须跨平台，不使用 POSIX-only 的 shell 环境赋值。

## validation
- `node --test tests/electron-preview-launch.test.mjs`
- `npm run typecheck --workspace @opencraft/workbench-electron`
- `npm run build:electron`
- 隔离 profile 与空闲 CDP 端口启动真实 Electron 44 预览。

## decisions
- 用 Node launcher 统一开发启动边界，而不是降级 Electron、在 Main 中兼容路径字符串或要求每个调用方手工清变量。

## scan_scope
- `opencraft/apps/workbench-electron`、`opencraft/scripts`、相关 package scripts 与预览文档。

## scan_output
- 有界终端证据，不生成额外扫描产物。

## handoff
- 修复与验证完成；隔离 Electron 预览正在运行，未提交、推送、打包或发布。
