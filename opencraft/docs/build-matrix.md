# OpenCraft Build Matrix

The repository has one shared semantic core and multiple delivery surfaces. A
successful TypeScript build is not evidence that every surface is deployable,
so each surface is an explicit matrix target with its own artifact contract.

| Target | Renderer/runtime | Output | Build host |
| --- | --- | --- | --- |
| `web-browser` | Vite, HTTP origin, same-origin `/appserver` gateway | Hashed static release | Linux/macOS/Windows |
| `lightvela-web` | LightVela/Hermes Vite product, no HyperNode plugin | `dist-lightvela-web` hashed static release | Linux/macOS/Windows |
| `electron-renderer` | Vite, origin-root asset URLs, Electron loopback origin | Relocatable renderer tree | Linux/macOS/Windows |
| `electron-host` | Sandboxed Electron main/preload + static loopback origin + independent OpenCraft Daemon | Main/preload, daemon executable and pinned DSH runtime | Linux/macOS/Windows |
| `electron-macos-arm64-zip` | Electron host + renderer | Apple Silicon `.app` ZIP | Linux/macOS |
| `electron-macos-arm64-preview` | Electron host + renderer | Isolated Apple Silicon ad-hoc `.app` ZIP | macOS |
| `electron-macos-arm64-dmg` | Electron host + renderer | Apple Silicon DMG | macOS |
| `electron-macos-x64-zip` | Electron host + renderer | Intel `.app` ZIP | Linux/macOS |
| `electron-macos-x64-dmg` | Electron host + renderer | Intel DMG | macOS |
| `electron-linux-x64-appimage` | Electron host + renderer | Portable x86_64 AppImage | Linux |
| `electron-linux-x64-rpm` | Electron host + renderer | TencentOS/RHEL/Fedora RPM | Linux |
| `electron-linux-x64-deb` | Electron host + renderer | Debian/Ubuntu amd64 package | Linux |
| `expo-web` | Expo Router + Metro Web | Expo static export | Linux/macOS/Windows |
| `expo-ios-bundle` | React Native + Metro | JS bundle and assets | Linux/macOS; native archive on macOS |

The browser and Electron targets intentionally do not share a built `index.html`.
They share source and chunks, but have different origin contracts. Electron
serves `electron-renderer` from a private, static-only loopback origin; loading
with `file://` would weaken navigation and asset policy. AppServer traffic does
not pass through that HTTP origin.

Commands:

```sh
npm run matrix:list
npm run matrix:check
npm run matrix:build -- web-browser electron-renderer electron-host
npm run build:lightvela-web:release
OPENCRAFT_WEB_RELEASE_ROOT=/explicit/static/root npm run publish:lightvela-web
npm run matrix:build -- electron-linux-x64-appimage
npm run matrix:build -- electron-linux-x64-rpm
npm run matrix:build -- electron-linux-x64-deb
npm run package:electron:mac:arm64:preview
```

`deploy:lightvela-web` builds the LightVela product and publishes only
`apps/workbench-web/dist-lightvela-web`, after its product boundary check.
`publish:lightvela-web` explicitly selects that same input even when the generic
`OPENCRAFT_WEB_BUILD_ROOT` is set. The target still belongs to the deployment:
set `OPENCRAFT_WEB_RELEASE_ROOT` to the reviewed static root before publishing;
the default is only the local `.runtime/workbench-web` tree. This command does
not provision a domain, gateway, account, or Collaboration backend. Generic
`deploy:web` is unchanged. OpenCraft does not regain a dedicated mono2 CI/MR
guard through this product release entrypoint.

Desktop packaging jobs are downstream targets. Linux AppImage, RPM, and DEB
consume the same standard-Oxc-minified renderer and bundled host. No desktop
target applies the retired ultra compression or high-obfuscation pass. RPM is the native
TencentOS/RHEL/Fedora installation contract; AppImage is the portable smoke
artifact; DEB covers Debian/Ubuntu. Application ZIPs can be
cross-built, while DMG creation, signing, notarization, and the final smoke test
run on macOS. Every package consumes only the verified `electron-renderer`
artifact and separately compiled Electron host.

The explicit macOS preview command is a local QA contract, not a distribution
artifact. It writes below `release/preview`, uses product name `OpenCraft
Preview`, Bundle ID `ai.lightvela.vela.preview`, and the independent
`OpenCraft Preview` application-state profile. It disables certificate discovery,
prunes foreign-platform `node-pty` prebuilds from both packaged runtime trees,
and applies one consistent ad-hoc hardened-runtime signature and entitlements
to the Electron helpers and outer app before ZIP creation. Release ZIP/DMG
commands retain their Developer ID and notarization responsibilities.

The Electron host never loads the application with `file://`, but its loopback
server is only a static asset owner. Renderer App Host frames cross a transferred
`MessagePort`; Electron Main relays those frames over authenticated local IPC to
the separately bundled OpenCraft Daemon. Only the daemon starts the pinned DSH
runtime, local Agent AppServer and physical transports. The desktop build has no
`/appserver` proxy or `OPENCRAFT_APPSERVER_URL` fallback.

For isolated Skills acceptance, set `OPENCRAFT_SKILLS_DIRECTORY` alongside
`OPENCRAFT_MODEL_STORAGE_DIRECTORY` and a fresh `--user-data-dir`. Main forwards
the Skills root through the daemon's `--skills-directory` option to the local
Host. Omission retains `~/.opencraft/skills`; changing the model/profile directory
alone does not isolate Skill writes. `scripts/skills-desktop-fixture.ts` seeds
only a synthetic loopback model and temporary roots for manual desktop QA.

The `web-browser` artifact does not contain the local Host, DSH, Node APIs, or
their extension entry. Its `/appserver` endpoint is owned by the deployment
gateway and may route to a cloud Host. This is a packaging boundary: desktop
ships the Agent next to the application; Web ships only the AppServer client.

## macOS Developer ID 签名包运行手册

仅在用户授权本地打包/签名后执行。打包不隐含安装、提交或远端发布。
`beforePack` 要求原生目标 OS/架构与构建机一致，不能把本机 DSH 原生依赖复制成另一架构的可运行包。

### 构建与身份

在 `opencraft/` 核对分支、dirty 状态和目标架构，记录本次是否包含未提交修改；
运行相关验证后重新执行 `npm run build:electron`。不能只重用上次 Renderer 或 Daemon 输出。
从 `apps/workbench-web/dist-electron/version.json` 读取本次 buildId，不以 `0.1.0` 等版本号判断包是否最新。

```sh
rtk proxy security find-identity -v -p codesigning
rtk proxy uname -m
rtk proxy npm run build:electron
```

以下例子在 `opencraft/apps/workbench-electron/` 执行。先将 `signing_identity` 替换为本次已验证的
Developer ID 身份名称（electron-builder 的 identity 选项使用姓名/团队部分，不加证书类型前缀）。
`arm64` 只适用于 Apple Silicon 原生构建机；Intel 目标在原生 Intel 构建机上使用 `x64`。

```sh
signing_identity="已核验的姓名与团队标识"
signed_output="release/signed-$(date -u +%Y%m%d-%H%M%S)"
rtk proxy env -u CSC_IDENTITY_AUTO_DISCOVERY -u OPENCRAFT_MAC_PREVIEW \
  ../../node_modules/.bin/electron-builder --mac dmg zip --arm64 --publish never \
  --config.directories.output="$signed_output" \
  --config.mac.identity="$signing_identity" \
  --config.forceCodeSigning=true --config.dmg.sign=true
```

保留项目现有 hardened runtime、entitlements、beforePack 与 afterPack。
afterPack 只在新组装的包中整理目标架构 PTY 并修正 helper 执行权限；不修改用户安装版。
签名可能逐个处理大量内嵌资源。等待期间检查当前子进程/日志是否推进，不凭持续时间认定卡死，
也不要把仍在生成的 ZIP/DMG 当成最终制品。

### 签名不等于公证

Developer ID 证书允许签名，但不会自动提供 Apple 公证授权。读取凭据配置时只报告存在性，
不打印密钥、密码或 token。若使用钥匙串 profile，必须先确认其实际名称；
找不到某个 profile 或环境变量为空，不代表机器上所有公证凭据都不存在。

当前 electron-builder 支持 Apple ID、App Store Connect API 或明确的 keychain profile 配置。
日志中的 `skipped macOS notarization` 是缺失的交付步骤，不是公证成功。
只有实际提交获得接受结果、完成对应票据处理并通过验证后，才能报告公证完成。
如果后续公证/重签改变 `.app` 或 DMG，需重新封装对应制品、生成 blockmap 和最终 SHA-256。

### 最终制品验收

将下列参数替换为本次最终制品的明确路径，不指向旧 `release/mac-arm64` 或 `/Applications`：

```sh
rtk proxy codesign --verify --deep --strict --verbose=2 "$signed_app_path"
rtk proxy codesign -d --verbose=4 "$signed_app_path"
rtk proxy codesign --verify --verbose=2 "$signed_dmg_path"
rtk proxy hdiutil verify "$signed_dmg_path"
rtk proxy unzip -t "$signed_zip_path"
rtk proxy spctl --assess --type execute --verbose=4 "$signed_app_path"
rtk proxy shasum -a 256 "$signed_dmg_path" "$signed_zip_path"
```

- 核对实际签名 Authority、TeamIdentifier、架构、hardened runtime 与时间戳。
- `spctl` 若返回 `Unnotarized Developer ID`，保留拒绝结果并告知用户；不能用签名校验通过覆盖它，也不关闭系统安全机制。
- 比较包内 `renderer/version.json`、`runtime/opencraft-daemon.cjs` 与 DSH 插件脚本和本次构建，记录构建来源与 SHA-256。
- 启动包内真正的 `Contents/MacOS/OpenCraft`，清除 `ELECTRON_RUN_AS_NODE`，使用全新 user-data-dir、模型存储目录和空闲调试端口。仅隔离 user-data-dir 不会隔离默认的 `~/.opencraft` 模型配置。
- 在该签名进程中验证首页、相关导航与本次修改。不得复用旧源码预览的结果冒充包体验证，不登录或发送付费请求来做默认烟测。
- 输出说明分别列出：源码/dirty 状态、buildId、App/DMG 签名、公证/Gatekeeper、完整性、启动/功能验证、未通过门禁，以及是否安装或发布。一次能启动不等于完整分发资格。
