## goal

用当前 dirty working tree 重建 Developer ID 签名的 arm64 OpenCraft App，安全替换 `/Applications/OpenCraft.app`，重启并验证本轮模型/思考控件。

## non_goals

- 不提交、推送、上传或发布。
- 不修改用户的 `~/Library/Application Support/OpenCraft` 或 `~/.opencraft` 数据。
- 不声称未执行的 Apple 公证。

## requirement_refs

- `user-2026-09-22-update-application`：“更新applection”，结合上文指更新已安装的 OpenCraft macOS App。

## context_receipt

- `AGENTS.md`、`opencraft/AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `opencraft/.agents/skills/opencraft-maintenance/references/verification.md`
- `opencraft/docs/build-matrix.md`
- `docs/context/tasks/2026-09-21-zencode-macos-package.md`

## acceptance

- 新包使用 `Developer ID Application: jindong zhang (BF993VYGGF)` 签名，架构为 arm64，包含 buildId `20260922053305-d0e96df3a33d` 或更新的重建 ID。
- 替换前将当前 App 保存为可恢复备份；只替换 `/Applications/OpenCraft.app`。
- 替换后 deep/strict codesign 通过，重启真实安装 App，验证安装包 buildId 和模型/思考菜单。

## validation

- `npm run build:electron`
- Developer ID `electron-builder --mac zip --arm64`
- `codesign --verify --deep --strict`
- `unzip -t`
- 安装包重启与 UI 验收

## handoff

- 已完成：Developer ID 签名 arm64 App/ZIP 位于 `opencraft/apps/workbench-electron/release/signed-20260922-054145-application-update/`。
- 已安装至 `/Applications/OpenCraft.app`并重启；安装包 buildId 为 `20260922053305-d0e96df3a33d`，Identifier `ai.lightvela.vela`，TeamIdentifier `BF993VYGGF`，arm64，deep/strict codesign 通过。
- ZIP SHA-256：`53977d999be82c3163901bc603f2fcb41ee538c9018af95af54255cbe890ea85`；包内 Daemon 与本轮构建哈希相同。
- 旧安装版备份 ZIP：`OpenCraft-installed-before-update.zip`，SHA-256 `e5157c02203041ec44a58f71f677313b4cb31af21126a6b7648bd69139716642`；原 App 同时移入 `~/.Trash/OpenCraft-before-update-20260922-054145.app`。
- 实际安装 App 启动并恢复用户任务/模型目录；打开真实模型菜单验证新 Renderer，随后恢复原模型 `deepseek-v4-pro-202606`。
- Gatekeeper 仍拒绝为 `Unnotarized Developer ID`；本轮未提交 Apple 公证，未上传、提交或推送。
