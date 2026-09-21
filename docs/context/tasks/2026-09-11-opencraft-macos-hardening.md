## goal
修复首次 OpenCraft macOS 打包验收暴露的运行时故障与预览交付缺口，使 Apple Silicon preview 构建可重复、可验证、可直接启动。

## non_goals
- 不执行 Developer ID 正式签名、Apple notarization、发布或生产变更。
- 不提交、推送或创建 MR。
- 不用破坏性依赖升级换取表面上的 audit 清零。

## requirement_ids / requirement_refs / requirement_excerpt
- 用户确认（2026-09-11）：修复已列出的 OpenCraft macOS 预览问题。
- R1：Laboratory 在 Electron 包中可打开。
- R2：有会话时切换国内/国际区域不产生未捕获异常。
- R3：提供确定性的本地 preview 打包与 ad-hoc 签名命令。
- R4：preview 与已有正式/本地应用隔离 Bundle ID 和用户数据。
- R5：收敛包体、大 chunk、依赖审计与安装脚本策略问题。

## interface_refs / data_structure_refs
- `AnnouncementContribution.media.url` 校验边界。
- `LightVelaAccountService.selectRegion()` 会话不变量。
- Electron Builder `build.mac`、`appId`、`extraResources` 与 workspace scripts。
- DSH runtime manifest 与 native target 检查。

## history_context
- `current_design_refs`：`opencraft/docs/platform-architecture.md`、`opencraft/docs/build-matrix.md`。
- `relevant_evolution`：Electron renderer 使用私有 loopback origin；桌面包携带独立 daemon 与固定 DSH runtime。
- `superseded_refs`：无。

## acceptance
- R1/R2 具备自动化回归测试并通过 packaged-app live QA。
- preview 命令不发现或使用 Developer ID，产出一致 entitlements 的 ad-hoc arm64 `.app` ZIP。
- 从 ZIP 解压后的精确二进制可启动，且不会与默认 Bundle ID/user-data 混淆。
- 包体与 chunk 指标相对基线有可测改善，或记录无法安全缩减的具体证据。
- npm audit 的 high 项被安全移除；其余项按运行时可达性与升级风险记录。

## affected_paths
- `opencraft/apps/workbench-web/`
- `opencraft/apps/workbench-electron/`
- `opencraft/packages/extension-runtime/`
- `opencraft/plugins/lightvela-hermes/`
- `opencraft/scripts/`
- `opencraft/tests/`
- `opencraft/package.json`、`opencraft/package-lock.json`
- 对应正式设计文档与本 Task Pack。

## required_context
- 根 `AGENTS.md` 与路由器结果（无匹配 Pack）。
- `opencraft/AGENTS.md`。
- `opencraft/docs/platform-architecture.md`。
- `opencraft/docs/build-matrix.md`。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | P0 边界与 Context 规则 | 限定本地源码/构建，不发布 |
| `opencraft/AGENTS.md@working-tree` | workspace 与构建约束 | 保持独立 npm 锁文件和多端边界 |
| `opencraft/docs/build-matrix.md@working-tree` | Electron 产物契约 | 不混淆 renderer、host 与 package |
| `opencraft/docs/platform-architecture.md@working-tree` | Workbench、extension 与 Electron 所有权 | URL 适配留在 Web；签名留在 Electron package lifecycle |
| `docs/engineering/domains/agent-gateway-runtime.md@working-tree` | change-impact 正式设计真源 | 同步 preview 与公告不变量 |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@working-tree` | 静态资源/前端测试邻接 | 检查实现与相邻测试，不改生成 i18n |

## evidence
- 初始问题和产物证据见 `docs/context/tasks/2026-09-11-opencraft-macos-preview-build.md`。
- 新增 `package:electron:mac:arm64:preview`；从 clean `npm ci` 到 ZIP 的完整命令退出 0，未发现 Developer ID。
- 最终产物 `opencraft/apps/workbench-electron/release/preview/OpenCraft-Preview-0.1.0-mac-arm64.zip`，约 209 MiB，SHA-256 `53c9595f4ea175bf400407d765ea8a130eac52e444784c55b02b068d95a6f24f`；ZIP 完整性与解压后 strict deep codesign 均通过。
- 解压后 Bundle ID 为 `ai.lightvela.vela.preview`、arm64 可执行文件；无 `--user-data-dir` 启动后创建独立 `@vela/workbench-electron-preview` profile，精确进程路径可见。
- packaged app 的 Settings → Laboratory → Preview announcement 成功显示带图片语义、动作与关闭控件的公告 Modal；进程未输出 runtime error。
- 区域切换使用 typed `LightVelaRegionSwitchRequiresSignOutError`，UI 只捕获该预期拒绝并就地 `role=alert` 呈现，未知异常继续抛出；聚焦测试覆盖有 token 时不改 region。
- target-aware post-pack 裁剪后两个 node-pty 副本均只剩 `darwin-arm64`；app 从约 686 MiB 降至 596 MiB，ZIP 从约 240 MiB 降至约 209 MiB。
- Tailwind/PostCSS 升至 4.3.3 后 high audit 项归零；严格版本固定 `allowScripts` 的 clean `npm ci` 通过且无未审核脚本告警。剩余 13 moderate 均在 Expo 链，npm 只建议破坏性降级到 Expo 46，未执行。
- 手工 Rolldown workbench-entry 拆分曾把 2.05 MiB chunk 降到 <480 KiB，但 packaged live QA 出现循环依赖执行顺序白屏，已回退；大 entry 作为源码级 lazy-boundary 后续项保留。
- 聚焦 runtime 17 项、packaging/release 12 项、受影响 workspace typecheck、matrix、documentation 与 change-impact guard 全部通过；Web、Expo Web、Expo iOS 构建通过。
- `npm run gate` 唯一阻塞为历史已知、本机可独立复现的 node-pty `posix_spawnp failed`；extension 116 项、同组 AppServer 118 项及 Workbench 186 项通过，达到三次同签名后停止重试。

## risks
- 签名顺序或 entitlements 错误会产生“验签通过但 dyld 拒绝”的假阳性；必须执行解压后二进制 smoke。
- DSH 含 native module，排除文件必须保留目标架构二进制与运行依赖。
- 大依赖升级可能破坏 Expo/native surface；只接受门禁覆盖的升级。

## validation
- 受影响包聚焦测试与 typecheck。
- `npm run matrix:check`。
- `npm run gate`。
- preview clean build、ZIP integrity、strict codesign、exact-path launch、CUA runtime QA。
- `python3 .agents/context/scripts/validate_change_impact.py --repo . --staged`。

## decisions
- 新增 preview target，不改变 release target 的 Developer ID/notarization 语义。
- 错误在拥有交互的 UI surface 就地呈现，不吞掉服务层不变量。

## scan_scope
- `opencraft/apps/workbench-electron/`
- `opencraft/apps/workbench-web/src/components/modal/`
- `opencraft/packages/extension-runtime/`
- `opencraft/plugins/lightvela-hermes/src/account/` 与 `src/settings/`
- `opencraft/scripts/`、`opencraft/tests/`

## scan_output
- 本 Task Pack 已吸收临时 planning/findings/progress 记录；临时根目录文件不进入提交。

## handoff
- 当前状态：核心 runtime 与 preview 打包问题已修复，最终 ZIP 已打开并保持运行。
- 下一步：用户已授权 commit、pull/rebase 与 push；大 workbench entry 应通过源码级 lazy boundaries 单独优化，不能恢复已证明会白屏的手工 chunk 分组。
- 阻塞项：本机 node-pty 测试环境仍返回 `posix_spawnp failed`；Expo audit 仍有 13 个只能通过破坏性降级处理的 moderate 告警。
