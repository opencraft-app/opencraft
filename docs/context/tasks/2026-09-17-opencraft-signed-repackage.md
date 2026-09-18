## goal
按用户“重新打包签名应用”生成当前源码的 macOS Apple Silicon 签名 DMG/ZIP。

## non_goals
不修改版本/分支、不提交发布、不替换 Applications、不修改用户 profile；公证与签名分别报告。

## source / context_receipt
分支 codex/opencraft-master-preview-20260916，HEAD 5d37f4877，包含当前未提交修改。已读 release-gitops router must_read、OpenCraft build-matrix、Electron package.json、beforePack/afterPack 脚本及此前维护/桌面验收技能。Developer ID 身份已实时验证；公证环境变量只有存在性检查，没有输出凭据。

## acceptance
重新 build renderer/host；独立输出目录；Developer ID 签名验证、DMG 完整性与归档检查、构建身份核对、隔离 profile 实机启动；如无公证不得声称 Gatekeeper 分发就绪。

## stage
已完成，输出 opencraft/apps/workbench-electron/release/signed-20260917-092850。保留旧包。

## risks
已有 typography 测试断言失败，不宣称完整质量 gate 全绿。当前树有其他人的变更，禁止还原或清理。

## verified
- Fresh Electron build、electron-builder dmg+zip arm64 with forced Developer ID signing、DMG sign=true、publish=never 全部退出 0。
- App deep/strict signature 与 DMG signature 有效，team BF993VYGGF；DMG CRC 和 ZIP test 通过。
- 包内 Renderer version、Daemon、DSH thread-engine 与新构建逐字节一致；buildId 20260917092931-a148b1fdd92b。
- 使用隔离 profile 启动真正的签名 App，首页、Skills→后退可用，普通模式 Cloud Storage 隐藏。

## unverified / handoff
本次未公证：electron-builder 无可生成的 notarize options；指定 opencraft keychain profile 只读查询也不存在，不推断其他未知 profile 不存在。spctl 返回 Unnotarized Developer ID，不能宣称 Gatekeeper 分发就绪。没有替换 Applications、登录、付费调用、commit 或发布。构建说明及 SHA256 在输出目录 BUILD-INFO.md。

## durable guidance
用户追加要求将经验写入 AGENTS。已将短交付不变量加入 opencraft/AGENTS.md，详细命令与签名/公证/隔离验收清单加入 docs/build-matrix.md；不固化本次证书、临时目录和构建编号，不修改全局记忆。
