---
id: opencraft-master-installer-20260922
type: task
scope: Build and locally verify a signed Apple Silicon OpenCraft installer from merged master.
triggers: ["new OpenCraft installer", "macOS package"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-22-opencraft-master-installer.md
status: complete
reviewed_at: 2026-09-22
review_due: 2026-12-21
revision: 1.0.1
precedence: task
derived: false
---

## goal
从已合入的 `origin/master` 生成新的 macOS arm64 OpenCraft Developer ID 签名 DMG/ZIP，并验证包内容、签名、镜像、归档及隔离启动。

## non_goals
- 不覆盖 `/Applications/OpenCraft.app`，不终止正在运行的用户实例。
- 不上传、发布、提交 Apple 公证或修改生产环境。
- 不把构建产物、隔离 profile 或机器路径提交到 Git。

## source
- revision: `6bf71ccde29785f2608f1f8d53fc0a6ae3a7c32b`
- architecture: `arm64`
- signing identity: `Developer ID Application: jindong zhang (BF993VYGGF)`
- build checkout: 独立 detached worktree，禁止复用其他 checkout 的 `node_modules` 或输出。

## acceptance
- 新构建包含明确的 buildId/sourceRevision，生成 `.dmg` 与 `.zip`。
- App 与 DMG 的 codesign 验证、DMG `hdiutil verify`、ZIP `unzip -t` 通过。
- 核对 arm64、hardened runtime、包内 Renderer/Daemon/DSH 资源和 SHA-256。
- 使用全新 user-data/model roots 隔离启动包内真实 App；不登录、不发起付费推理。
- 单独报告 Gatekeeper/公证状态；未公证不得称为可分发完成。

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@6bf71ccde297` | 仓库交付边界 | 不发布、不覆盖安装版 |
| `opencraft/AGENTS.md@6bf71ccde297` | Electron 与目录身份规则 | 隔离构建和启动 |
| `opencraft/docs/build-matrix.md@6bf71ccde297` | macOS 签名包运行手册 | 构建、签名和验收命令 |
| `desktop-apps/SKILL.md@local` | 桌面应用交付规范 | Electron 包和安全边界 |

## evidence
- buildId：`20260922142446-6bf71ccde297`；`version.json.sourceRevision` 为完整 merge commit `6bf71ccde29785f2608f1f8d53fc0a6ae3a7c32b`。
- 输出：`~/Downloads/OpenCraft-20260922142446-6bf71ccde297/OpenCraft-0.1.0-arm64.dmg`（190362431 bytes）和 `OpenCraft-0.1.0-mac-arm64.zip`（206742644 bytes）。
- App `codesign --verify --deep --strict` 通过；Developer ID `BF993VYGGF`、arm64、hardened runtime 和时间戳存在。
- DMG codesign 与 `hdiutil verify` 通过；ZIP `unzip -t` 通过。
- SHA-256：DMG `727067e9413630059c00df30e14aa18fd58b287ab74eb2fc59d4f5ae16277387`；ZIP `4b9cd514a81a1ca94904888e7914604f48a77f7cd741100a48f86555c50e84a7`。
- 包内存在 Renderer embedded loader、OpenCraft Daemon、DSH capability/skill invocation runtime。
- 真实包以隔离 user-data、OpenCraft home、models、skills、agents 和 Codex home 运行 `smoke-project-picker` 通过：native capability、取消、持久化、去重、迟到选择隔离和重启恢复。
- `spctl` 返回 `rejected source=Unnotarized Developer ID`；本轮按计划未提交公证。

## handoff
- 构建与本地验收完成；未安装、未上传、未发布、未公证。
