---
id: opencraft-github-macos-release-20260923
type: task
scope: Add a GitHub Environment-backed Universal macOS release pipeline to the downstream OpenCraft mirror.
triggers: ["OpenCraft GitHub macOS release", "Universal DMG", "macos-release Environment"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-09-23-opencraft-github-macos-release.md
status: completed
reviewed_at: 2026-09-23
review_due: 2026-12-22
revision: 1.1.0
precedence: task
derived: false
---

## goal
让 GitHub 下游镜像在原生 arm64 与 x64 Runner 上组装应用，经 `macos-release` Environment 签名、公证并产出可验证的 Universal DMG/ZIP。

## non_goals
- 不改变 mono2 作为唯一源码权威，不从 GitHub 反向 pull。
- 不在仓库、日志、Task Pack 或聊天中保存 Apple 凭据值。
- 不替用户确认 GitHub 付费或 Apple 外部交易。
- 不覆盖本机 `/Applications/OpenCraft.app`。

## requirement_ids / requirement_refs / requirement_excerpt
- `user-2026-09-22-github-universal-macos`：学习成熟桌面壳的 Universal DMG 与 GitHub 自动制品做法，并使用 GitHub Environment 托管凭据。
- `user-2026-09-23-proceed`：确认单席位模型后要求继续实施。

## interface_refs / data_structure_refs
- `opencraft/.github/workflows/macos-universal-release.yml`
- `opencraft/scripts/merge-macos-universal.mjs`
- `opencraft/scripts/sign-notarize-macos.mjs`
- `opencraft/apps/workbench-electron/package.json#build`
- 不变量：两架构在各自原生 Runner 组装；秘密只进入最终 Environment job；签名、公证、封包与验证顺序不可颠倒。

## history_context
- `current_design_refs`：`opencraft/docs/build-matrix.md`、`opencraft/MONO2_MIGRATION.md#public-github-mirror`。
- `relevant_evolution`：此前本机 arm64 Developer ID 包已验证但未公证；GitHub workflow 只构建当前 Runner 架构且没有 Environment。
- `superseded_refs`：单一 Runner 直接 `electron-builder --mac dmg` 不能证明 Universal 或公证交付。

## acceptance
- arm64/x64 jobs 在对应原生 Runner 构建且不接触签名秘密。
- Universal job 由 `macos-release` Environment 提供秘密，合并后完成 Developer ID 签名、Apple 公证、staple、DMG/ZIP 与 checksums。
- workflow 与合并逻辑有聚焦测试；package lock、构建矩阵文档和镜像边界同步。
- Team 套餐和 Apple 公证凭据未就绪时明确报告外部阻塞，不把源码完成称为已发布。

## affected_paths
- `opencraft/.github/workflows/macos-universal-release.yml`
- `opencraft/scripts/merge-macos-universal.mjs`
- `opencraft/scripts/sign-notarize-macos.mjs`
- `opencraft/tests/macos-universal-release.test.mjs`
- `opencraft/scripts/sync-shared-packages.mjs`
- `opencraft/tests/shared-package-snapshots.test.mjs`
- `opencraft/packages/lightvela-agent-core/`
- `opencraft/packages/vela-chat-client-core/`
- `opencraft/apps/workbench-electron/package.json`
- `opencraft/package-lock.json`
- `opencraft/package.json`
- `opencraft/docs/build-matrix.md`

## required_context
- 根 `AGENTS.md`
- `opencraft/AGENTS.md`
- `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`
- `opencraft/docs/build-matrix.md`

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@working-tree` | GitHub 镜像与外部操作边界 | 保持单向镜像和显式 push |
| `opencraft/AGENTS.md@working-tree` | 桌面签名交付规范 | 分开源码、制品、公证与发布 |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft 维护与验证 | 选择真实桌面交付证据 |
| `opencraft/docs/build-matrix.md@working-tree` | 当前 macOS 打包权威 | 扩展 Universal/Environment 契约 |
| `desktop-apps/SKILL.md@local` | Electron 交付边界 | 保持 Main/Renderer 与原生包验证 |

## evidence
- `npm run test:macos-release`：4/4 通过，覆盖架构资源并集、架构无关 Renderer 归一、workflow secret/job 边界与缺凭据的 fail-fast。
- `npm run test:identity`：OpenCraft identity 11/11、DSH prepare/packaging 10/10 通过。
- `npm run matrix:check`：13 个现有单机构建目标有效；Universal 作为多 Runner 编排目标单独记录。
- `npm run typecheck --workspace @opencraft/workbench-electron` 与 `git diff --check` 通过。
- `validate_change_impact.py` 与 `validate_documentation.py` 通过；Context catalog 已重建。全仓 Context unittest 26 项中 4 项仍被既有旧 Task Pack schema、超长参考仓库指令链、断链和历史 secret-literal 候选阻塞，本任务新增 Task Pack 未出现在失败项中。
- GitHub API 已确认 `opencraft-app` plan=`team`。`macos-release` 已启用 custom deployment policy，仅接受 branch `main` 与 tag `v*`。
- 已将精确选择的 `Developer ID Application: jindong zhang (BF993VYGGF)` 单身份 P12 及随机包装密码写入 Environment Secrets；未上传同钥匙串中的其他身份，也未输出凭据值。
- App Store Connect 团队未开放 Integrations/API 入口，未把本机 P8 候选误认作可用 Team Key。已按 Apple 官方支持的 Apple 账户、App 专用密码与 Team ID 路径配置公证。
- `macos-release` 现有五项 Secret：Developer ID P12、P12 包装密码、Apple 账户、App 专用密码与 Team ID；Secret 值未写入仓库、日志或 Task Pack。
- 首次 GitHub workflow `35811006754` 在 arm64/x64 的 Renderer build 暴露镜像缺少 `@lightvela/vela-chat-client-core`；修复采用从 mono2 `shared/` authority 机械同步的 workspace 快照，同时补齐同类 `@lightvela/agent-core`，不以 Vite external 掩盖运行时缺包。
- 在不含 mono2 父目录、node_modules 与历史构建输出的临时独立 checkout 中，`npm ci`、`check:shared-packages` 与 `build:electron:release` 通过。
- 第二次 GitHub workflow `35814021276` 在 identity gate 证明旧规则会拒绝权威的 `@lightvela/*` 快照包名；规则现仅对两个带 `UPSTREAM.json` 且 source 精确指向 `shared/` 的包开放，其他 workspace 继续强制 `@opencraft/*`。
- 第三次 workflow `35814687835` 证明双架构原生 App 均可成功构建，并暴露两个原生 Runner 产生不同 Vite 内容哈希；合并器现选择单一架构无关 Renderer，同时保留两套架构限定运行时。
- workflow `35818902658` 的第 4 次 attempt 已证明 Universal 合并、单一 Developer ID 导入、签名、Apple 公证与 staple 全部成功；随后暴露 electron-builder 不接受带 `Developer ID Application:` 前缀的显式 identity。
- 最终 workflow `35824922149` 全部通过：arm64、x64、Universal、签名、公证、staple、DMG/ZIP、Gatekeeper、校验和与 artifact 上传均成功。最终 artifact 为 `opencraft-macos-universal-15cf470bc78e991af8d2eaa5aeeb7ca2299d26af`，保留 30 天。
- 最终 artifact 已下载到 `/Users/skipzhang/Downloads/OpenCraft-GitHub-15cf470` 并独立复核：DMG `hdiutil verify` 有效，ZIP 完整，SHA-256 与 `SHA256SUMS` 一致，主可执行文件为 `x86_64 arm64`，`codesign --verify --deep --strict`、`stapler validate` 与 Gatekeeper 均通过；Gatekeeper 来源为 `Notarized Developer ID`。

## risks
- 两架构原生依赖文件集合不同：合并前只补齐缺失的架构限定资源，绝不覆盖同路径文件；其余 Mach-O 由 `lipo` 合并。
- Environment 未受私有仓库人工审批保护：workflow 只允许主分支手工运行或 `v*` tag，秘密只授予最终 job；升级 Team 后限制部署分支/tag。
- GitHub macOS Intel Runner 计划于 2027 年结束：到期前评估自托管 Intel 或终止 Intel 支持。

## validation
- `npm run test:macos-release`
- `npm run test:shared-packages`
- `npm run check:shared-packages`
- `npm run test:identity`
- `npm run matrix:check`
- `npm run typecheck --workspace @opencraft/workbench-electron`
- `git diff --check`
- GitHub Team/Secrets 就绪后运行一次 workflow 并保存 App/DMG/ZIP/公证/Gatekeeper 证据。

## decisions
- 使用双原生 Runner + 最终合并，不在单一架构 Runner 上交叉伪装 DSH 原生依赖。
- 公开镜像所需的 mono2-parent shared package 以带哈希清单的机械快照闭包交付；`shared/` 仍是唯一真源。
- 使用临时 Keychain 与 Apple 官方支持的 App 专用密码；不使用 Apple 账户主密码。当前团队尚未开通 App Store Connect API，后续批准 Team Key 时可迁移，不改变制品模型。
- workflow_dispatch 生成 Actions artifact；`v*` tag 才创建 GitHub Release。

## scan_scope
- `opencraft/.github/workflows/`
- `opencraft/apps/workbench-electron/`
- `opencraft/scripts/`
- `opencraft/tests/`
- `opencraft/docs/build-matrix.md`

## scan_output
- Context Router 无匹配；已记录并对上述路径执行有界精确搜索。

## handoff
- 源码、mono2 `master`、GitHub 单向镜像、Team Environment、签名与公证凭据、真实双架构 workflow、Apple 公证、staple、Gatekeeper 和最终制品完整性均已验证。手工 `workflow_dispatch` 会生成 30 天 Actions artifact；推送 `v*` tag 才会额外创建 GitHub Release。
