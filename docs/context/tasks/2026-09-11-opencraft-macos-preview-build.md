## goal
在当前 Apple Silicon macOS 主机上，从 `mono2/opencraft` 源码构建一个可供本地预览的 OpenCraft macOS 应用包，并提供可复核的产物与完整性证据。

## non_goals
- 不修改 OpenCraft 产品行为或 UI。
- 不提交、推送、创建 MR、签名、公证或发布应用。
- 不变更 GitOps、生产环境、云资源或外部服务。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户请求（2026-09-11）：检查项目内的 OpenCraft，并确认能否构建 macOS 应用供预览。

## interface_refs / data_structure_refs
- `opencraft/package.json`：`package:electron:mac:arm64:zip` 构建入口。
- `opencraft/apps/workbench-electron/package.json`：Electron Builder 的应用标识、资源与产物配置。

## history_context
- `current_design_refs`：`opencraft/docs/build-matrix.md`。
- `relevant_evolution`：Electron renderer 与 host 是独立构建目标，macOS ZIP 是 Apple Silicon 预览产物。
- `superseded_refs`：无。

## acceptance
- OpenCraft workspace 依赖可重现安装。
- Electron renderer、host、daemon 与 DSH runtime 成功构建。
- 生成 Apple Silicon macOS `.app` ZIP；解压结构可验证，SHA-256 可复核。
- 对解压后的应用执行本地启动/进程或等价 smoke 验证；若签名或系统策略阻塞，明确记录。

## affected_paths
- `opencraft/`（仅生成被忽略的依赖与构建产物）。
- `docs/context/tasks/2026-09-11-opencraft-macos-preview-build.md`。

## required_context
- 根 `AGENTS.md` 路由结果：无匹配 Pack，要求在相关目录做有界精确搜索。
- `opencraft/AGENTS.md`。
- `opencraft/docs/build-matrix.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | 仓库 P0 边界与 Context 路由 | 限定为本地构建，不触发发布 |
| `opencraft/AGENTS.md@working-tree` | OpenCraft workspace 和构建约束 | 使用独立 npm workspace 与锁文件 |
| `opencraft/docs/build-matrix.md@working-tree` | macOS 产物契约 | 选择 `electron-macos-arm64-zip` |
| `opencraft/package.json@working-tree` | 根构建入口 | 执行 workspace 级打包脚本 |
| `opencraft/apps/workbench-electron/package.json@working-tree` | Electron Builder 配置 | 核对资源、架构与输出路径 |

## evidence
- `npm ci`：退出 0；按 OpenCraft 自有 `package-lock.json` 安装 1328 个 package，postinstall 完成 Xcode 26.2 兼容 patch。
- `npm run package:electron:mac:arm64:zip`：renderer、Electron host、OpenCraft daemon 与 DSH runtime 构建成功；Electron Builder 生成 arm64 `.app` 与 ZIP。
- Electron Builder 的自动 Developer ID 签名对大量静态资源逐项处理，因本任务只需本地预览而中止；干净重跑 `CSC_IDENTITY_AUTO_DISCOVERY=false` 后确认模板残留签名不满足严格校验。
- 对生成的 `.app` 及四个 Helper 使用本地 ad-hoc hardened-runtime 签名，并应用 Electron Builder 默认 entitlements；`codesign --verify --deep --strict --verbose=2` 退出 0。
- 最终 ZIP：`opencraft/apps/workbench-electron/release/OpenCraft-0.1.0-mac-arm64-preview.zip`，大小 241053324 bytes，SHA-256 `64bd34d4e89e6d8b3cb5c2f32ab3c091611fa1094f4932cac86d29118dcdb9cf`；`unzip -tq` 无错误。
- 从最终 ZIP 解压后再次严格验签通过；可执行文件为 `Mach-O 64-bit executable arm64`，Bundle ID 为 `ai.lightvela.vela`。
- 从最终 ZIP 解压得到的精确路径 `/tmp/opencraft-deliverable.rGzSUs/OpenCraft.app` 直接启动并保持运行；进程树与 CUA 均指向该路径，页面运行于独立 loopback origin `127.0.0.1:56658`，显示 LightVela 登录入口、New chat、Tasks 与 Settings。
- `npm run typecheck --workspace @opencraft/workbench-electron`：退出 0。
- `npm run matrix:check`：退出 0，13 个 target 有效。

## risks
- 未签名/未公证的本地预览包可能触发 Gatekeeper；不绕过系统策略，只记录本地启动结果与预览方式。
- npm 安装或 Electron 下载可能受网络影响；失败时保留精确命令证据并停止在本地范围。

## validation
- `npm ci`
- `npm run package:electron:mac:arm64:zip`
- ZIP 完整性、应用目录结构与 SHA-256 校验
- 解压后的 `.app` 本地 smoke 验证
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`（仅在存在暂存变更时需要）

## decisions
- 优先生成 ZIP：它直接包含 `.app`，适合本机快速预览，也避免把 DMG 生成误当作签名/公证完成。

## scan_scope
- `opencraft/apps/workbench-electron/`
- `opencraft/apps/workbench-web/`
- `opencraft/apps/opencraft-daemon/`
- `opencraft/runtime/dsh/`

## scan_output
- Graphify 输出写入仓库根 `graphify-out/`，仅用于本轮结构定位，不进入 Git。

## handoff
- 当前状态：本 Pack 记录首次构建与问题发现，已被 `2026-09-11-opencraft-macos-hardening.md` 的确定性 Preview 流程取代。
- 下一步：使用新产物 `release/preview/OpenCraft-Preview-0.1.0-mac-arm64.zip`；本 Pack 中的旧手工 ZIP 已移除，不再作为交付物。
- 阻塞项：无；首次构建证据仅供历史追溯。
