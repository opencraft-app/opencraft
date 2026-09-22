## goal

删除 Renderer 的 traffic-light 灰色快照层，让 macOS AppKit 成为窗口按钮的唯一 owner，消除原生红黄绿与仿制灰圆重影。

## non_goals

- 不替换 Electron 原生 traffic lights，不自建窗口按钮。
- 不改变 macOS safe-area、Sidebar/Header 几何或全屏规则。
- 不提交、推送、上传或公开发布。

## requirement_refs

- `user-2026-09-22-native-traffic-lights`：用户截图显示 traffic lights 后面偶发灰色重影，确认“删除吧”。

## context_receipt

- 根/OpenCraft AGENTS 与 Context Router（无匹配 Pack）。
- OpenCraft maintenance 验证清单。
- `BrowserWindow` Main chrome、Renderer `window-chrome`、AppShell Header/SCSS 和 window chrome tests。
- Electron #50099 / PR #50183：旧 hiddenInset + custom position 恢复闪烁已在上游修复并回传 40/41；当前 OpenCraft 使用 Electron 44.1.0。

## acceptance

- Renderer DOM/CSS 不再存在 `traffic-light-snapshot`。
- macOS 原生 traffic lights、safe-area、Sidebar toggle/back/forward 保持。
- 打包 App 实际启动，最小化/恢复及全屏/退出全屏后不出现灰色仿制圆。

## handoff

- 已完成：Header JSX、SCSS 和测试不再存在 Renderer traffic-light snapshot；`window-chrome` 只保留 AppKit hit-region safe-area。
- Workbench Web typecheck、window chrome/shell 22 项、Electron 构建与 deep/strict codesign 通过。
- 实际安装 App 的系统屏幕截图验证 focused 正常状态与最小化/恢复后均没有灰色仿制圆；DOM/CSS 无第二组 traffic lights。截图为 `/tmp/opencraft-native-lights-normal.png` 和 `/tmp/opencraft-native-lights-restored.png`。
- Developer ID arm64 包位于 `opencraft/apps/workbench-electron/release/signed-20260922-084057-native-traffic-lights/`；ZIP SHA-256 `71d9dd3f3d661cc2e6966fff68142530193a18cede9311d301a0e5f5ddf60d90`。
- 已更新并启动 `/Applications/OpenCraft.app`，buildId `20260922084042-fdbd0f011f93`；Gatekeeper 仍是 `Unnotarized Developer ID`，未提交 Apple 公证。
- 替换前安装版备份 `OpenCraft-before-native-traffic-lights.zip`，SHA-256 `fd3673aab602ca488a3cde27da87ea2c46e7de2f755fd3288eb99d572bbaaf27`；原 App 位于 `~/.Trash/OpenCraft-before-native-traffic-lights-20260922-084057.app`。
- 未提交、推送、上传或公开发布。
