## goal

修复 Electron 新任务页的项目目录选择，使原生 picker 归属于“当前 Electron + 本机执行 Host”能力，而不是写死逻辑 Host ID `local`。

## non_goals

- 不让 remote-ssh/durable/remote-control/WSL Host 选择 macOS 本地路径。
- 不改变 ProjectRepository、Thread workspace 或 Host 文件系统所有权。
- 不提交、推送、上传或公开发布。

## requirement_refs

- `user-2026-09-22-project-picker`：“选择项目（目录）似乎没有接线，不工作”。

## context_receipt

- 根/OpenCraft AGENTS 与 Context Router（无匹配 Pack）。
- OpenCraft maintenance/electron skills 与 project picker 验证清单。
- `new-thread-draft-page.tsx`、`project-folder-picker.ts`、Electron Main/Preload IPC、ProjectRepository 和 `smoke-project-picker.ts`。

## root_cause

- Main/Preload 已完整暴露 `opencraft:project-folder-pick`。
- Renderer `nativeProjectPicker(hostId)` 只接受字面量 `local`。当前默认 Codex Host 是 `local-codex`，虽然 profile `hostKind === "local"` 且物理上也在本机，picker 仍被投影为 `null`，导致 Add project 被禁用。

## acceptance

- Electron 中任意 `hostKind === "local"` 的 Host（包括 `local` 和 `local-codex`）共享 native picker。
- Web 和非 local Host 仍不暴露 macOS 路径选择。
- 取消不改变草稿；选择目录创建/复用项目；迟到结果不抢回已离开的页面；重启后恢复。

## handoff

- 已完成：`nativeProjectPicker` 不再识别逻辑 Host ID，只消费 `HostRuntimeDescriptor.kind`；Electron + `kind === "local"` 时使用 Main/Preload native picker。
- Workbench Web typecheck、Project/Host 17 项回归、平台边界和 Electron 构建通过。
- 新增/修正真实包 smoke 的当前导航和中文 Settings 定位。使用隔离 profile/项目根、真实打包 Main/Preload/Renderer，只替换 `dialog.showOpenDialog` 返回，验证取消、目录选择、去重、迟到结果隔离和进程重启恢复。
- Developer ID arm64 包位于 `opencraft/apps/workbench-electron/release/signed-20260922-080652-project-picker/`；ZIP SHA-256 `1fc1bd4b14e35f00e7338128b7cd4f7e609b409ac554345c983b6146a6ef33f0`。
- 已更新并启动 `/Applications/OpenCraft.app`，buildId `20260922080630-0420c4f4a99e`，deep/strict codesign 通过；Gatekeeper 仍拒绝为 `Unnotarized Developer ID`，未提交 Apple 公证。
- 替换前安装版备份 `OpenCraft-before-project-picker.zip`，SHA-256 `759d175d1169e47acd014ecba1fa9f47874b7790304791fee9e7b1ed674412d7`；原 App 位于 `~/.Trash/OpenCraft-before-project-picker-20260922-080652.app`。
- 未提交、推送、上传或公开发布。
