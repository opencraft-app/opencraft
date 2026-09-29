## goal
Build a standalone, installable Android APK for OpenCraft internal testing from the current Expo source.

## non_goals
- Play Store signing, submission, or publication.
- iOS packaging or changes to production services.

## requirement_ids / requirement_refs / requirement_excerpt
- User request in this conversation (2026-09-29): “最小目标：Android 内测 APK”.

## interface_refs / data_structure_refs
- `opencraft/apps/workbench-expo/app.json`: Expo native identity and Android version.
- `opencraft/apps/workbench-expo/package.json`: native build command.
- `opencraft/config/build-matrix.json`: artifact contract.
- Internal artifact must bundle JavaScript and be installable without Metro.

## history_context
- `current_design_refs`: `opencraft/docs/build-matrix.md`, `opencraft/apps/workbench-expo/README.md`.
- `relevant_evolution`: OpenCraft previously built Expo Web and an iOS JS bundle, with no Android APK target.
- `superseded_refs`: none.

## acceptance
- `expo prebuild --platform android` generates the Android project from checked-in config.
- Gradle `assembleRelease` produces a signed APK, signature verification passes, and the artifact has a SHA-256 receipt.
- The local APK build is reproducible; a manual CI workflow is available once the OpenCraft subtree reaches its standalone GitHub mirror, without publishing externally.
- Real device behavior is stated separately from build evidence.

## affected_paths
- `opencraft/apps/workbench-expo/`
- `opencraft/config/build-matrix.json`
- `opencraft/.github/workflows/android-internal-apk.yml`
- `opencraft/docs/build-matrix.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- `agent-gateway-runtime`, `site-environment-routing`, `upstream-subtrees`, `service-opencraft`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `mono2/AGENTS.md` | 根交付边界 | 不提交、发布或变更生产 |
| `mono2/docs/context/domains/agent-gateway-runtime.md` | Agent 入口边界 | 限定本次为客户端打包 |
| `mono2/docs/context/domains/site-environment-routing.md` | 环境边界 | 不推断生产登录可用 |
| `mono2/docs/context/project/upstream-subtrees.md` | 源码所有权 | mono2 为唯一写入真源 |
| `mono2/docs/context/project/services/opencraft.md` | 服务入口 | 保持 OpenCraft 独立构建 |
| `mono2/opencraft/AGENTS.md` | 局部完成标准 | 源码、产物与运行验证分开 |
| `mono2/opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | 交付维护清单 | 对构建结果如实交接 |
| `mono2/opencraft/docs/build-matrix.md` | 构建事实 | 加入 Android 目标 |
| `mono2/opencraft/docs/architecture/product-identity.md` | 安装身份 | 沿用现有 Vela 安装标识 |
| `mono2/opencraft/apps/workbench-expo/README.md` | Native 登录边界 | 不把 APK 打包等同后端登录可用 |
| `mono2/docs/engineering/domains/agent-gateway-runtime.md` | 正式领域设计 | 记录 APK 只承载 Client 与远端依赖边界 |

## evidence
- `expo prebuild --platform android --no-install --no-clean` 生成 ignored Android 工程；生成的 release Gradle 配置使用 development keystore。
- 使用 JDK 17、Android SDK 36、两个 NDK 版本和 opt-in Maven mirrors 本地运行 `build-android-apk.sh`；`assembleRelease` 成功，最终增量复跑也成功。
- `release/OpenCraft-android-internal.apk` 为 116 MB；`sha256sum -c` 通过，SHA-256 `dab316c44542be55881e508e34af47d6c7651c37f53eb13f6471fe81ef9a4783`。
- `apksigner verify --verbose` 通过 v2 签名；证书为 Android Debug。`aapt dump badging` 显示包名 `dev.vela.workbench`、版本 0.1.0/code 1、min SDK 24、target SDK 36、四种 ABI。APK 内有 `assets/index.android.bundle`。
- Expo workspace TypeScript 检查、build matrix 检查、Bash 语法、YAML 解析、`git diff --check`、根文档验证均通过。
- `adb devices` 无已连接设备；未执行安装与真实登录链路。

## risks
- 内测 APK 使用开发签名，仅用于手动安装；不得作为商店制品。
- 真实登录依赖外部原生登录服务；构建成功不证明该链路可用。
- Android 安装图标目前仍为 Expo 生成的模板图标；本轮没有新增品牌资产。
- 当前工作树已有其他任务的未提交更改，本次仅编辑列出的路径。

## validation
- Expo config、matrix 检查、Expo Android prebuild、Gradle release、`apksigner verify`、SHA-256。
- OpenCraft 受影响 workspace typecheck 和必要构建门禁。

## decisions
- 选用本地 Gradle + 手动 GitHub Actions artifact，不引入 EAS 账户或发布凭据。
- 保留既有 `dev.vela.workbench` 安装身份，与 iOS 当前 bundle identifier 一致。

## scan_scope
- `opencraft/apps/workbench-expo`, `opencraft/config`, `opencraft/.github/workflows`。

## scan_output
- 精确检索表明现有构建矩阵仅覆盖 `expo-web` 与 `expo-ios-bundle`。

## handoff
- 本地 APK 与 SHA-256 文件已生成且未提交；源码配置和手动工作流已准备，未触发镜像推送、GitHub Actions、商店发布或生产变更。
- 下一步由测试者在 Android 设备安装并验证启动、登录和聊天；当前会话没有设备连接，外部登录服务也未验收。
