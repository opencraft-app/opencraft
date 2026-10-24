# Workbench Expo

Expo host for iOS, Android, and Expo Web. It consumes the same
`@opencraft/workbench-runtime` as the Vite/Electron renderer while keeping a native
view and native composer boundary.

The `workbench-frame.web.tsx` and `workbench-frame.native.tsx` files are host
adapters with a shared semantic component underneath. DOM-only packages such as
ProseMirror and the Web Workbench SCSS frame are intentionally unavailable here.

## Public and downstream product entries

`npm run start --workspace @opencraft/workbench-expo`, `export:web` and
`bundle:ios` use the existing public RN Workbench and direct Host. Set
`EXPO_PUBLIC_APPSERVER_WS_URL` to a reachable Host for a physical device.
No downstream sign-in or generated private Bot HTML is required for this entry.
Native math/Mermaid HTML remains packaged by the shared runner.

An explicit experimental `OPENCRAFT_EXPO_WORKBENCH=web` entry packages and runs
the complete existing Web touch Workbench in Expo. The container owns native
lifecycle, safe area, back and external navigation; Web retains application,
UI, state and storage. This does not switch the default or select a downstream
product. Commands and remaining acceptance are documented in
[Packaged Web Workbench](../../docs/mobile-workbench-container.md).

To select an **explicit downstream product**, run `node products/<product>/run-expo.cjs start --go` from the
downstream root, or `npm run expo:start --prefix products/<product> -- --go`. Its runner
selects the original Router/account/Bot entry and edition configuration.
The downstream `products/<product>` APK/IPA/agents-next aliases select that product
for the complete build. Public APK/IPA aliases use the public entry; agents-next
is owned only by the downstream product. Custom downstream builds may set `OPENCRAFT_EXPO_PRODUCT_ENTRY` and
`OPENCRAFT_EXPO_PRODUCT_CONFIG` to existing local entry and `.cjs` config files;
relative paths resolve from the OpenCraft workspace. These are trusted build
inputs, never HTTP parameters or remote code URLs. The legacy public development bundle identifiers are retained to preserve
installation continuity; product-specific permission text belongs to its config.

## 手机端路线

| 要做什么 | 标识与产物 | 从哪里开始 |
|---|---|---|
| iPhone 体验当前代码 | Expo Go 临时预览，依赖持续运行的 Metro | [真机快速体验](#iphone-真机快速体验) |
| Android 内测安装 | `dev.opencraft.workbench`，开发签名 APK | [Android 内测 APK](#android-internal-apk) |
| Android 正式包与资料 | 公开默认 `dev.opencraft.workbench`；下游产品自行声明正式包名，分别生成签名与包资料 | [Android 正式 APK](#android-release-apk) |
| iOS 可安装测试包 | 公开默认 `dev.opencraft.workbench`；产品包由显式产品配置声明 | [iOS IPA](#ios-site-shell-and-simulator) |

Expo Go 链接、Android APK 和 iOS IPA 是不同交付物。每次交付都从当前
checkout 构建并验证成品；构建成功本身不代表已经安装、上架或发布。

## iPhone 真机快速体验

公开默认入口是 RN Workbench/Composer，直连配置的 Host，不要求私有产品账号、
Bot 或登录页。设置 `EXPO_PUBLIC_APPSERVER_WS_URL` 为手机可达的 Host，再从仓库根运行：

```bash
npm ci
npm run start --workspace @opencraft/workbench-expo -- --go
```

1. 在 iPhone 上安装 [Expo Go](https://apps.apple.com/us/app/expo-go/id982107779)。
2. 核对电脑 CLI 的 `npx expo whoami` 与手机 Expo Go 登录同一 Expo 账号。外网预览按
   [Cloudflare Expo Go 预览 skill](../../.agents/skills/opencraft-expo-cf-preview/SKILL.md)
   启动并核验本次 manifest；Metro 与隧道须持续运行。
3. 把完整 `exps://` 链接粘贴到 Safari 地址栏，允许跳转 Expo Go。若开发服务器列表
   没有项目，可使用已核验的直达链接；直达链接不能绕过 Expo 的账号校验。
4. 打开 Workbench，检查配置 Host 的连接与会话。只有显式选择下游产品时才会进入
   该产品自己的账号、区域与 Bot 流程；其操作步骤由产品维护。

红屏或持续加载时先检查外网 manifest 和 Metro 日志，定位到 bundle 传输问题后再
检查完整 bundle。只核验 manifest 不能证明 Host、登录或模型链路已可用。
电脑缓存了其他 Expo 账号时先修正登录并重启 Metro，不向开发者发送密码。
Expo Go 是临时开发预览，不是已安装的独立 IPA。

需要 Expo 自带隧道时，可在启动参数中加 `--tunnel`；CLI 可能提示安装
`@expo/ngrok`。使用 HTTPS 反向代理时，设置 `EXPO_PACKAGER_PROXY_URL` 并打开
`exps://<proxy-host>`。若开发服务器列表仍依赖 Expo 隧道，可以用
`OPENCRAFT_EXPO_BUNDLE_ORIGIN` 为同一 Metro 选择独立 HTTPS bundle 代理。
这些开发传输配置不选择下游产品，也不改变 Host 或账号权限。

## iOS site shell and simulator

The public iOS entry uses the shared RN Workbench. A downstream site/account
shell is selected only through the trusted product entry described above.
On a Mac with Xcode and CocoaPods, run from the repository root:

```bash
npm ci
npm run dev:expo:ios
```

Expo prepares the native project, installs pods, builds the development client
and opens the iOS Simulator. The public development application ID is
`dev.opencraft.workbench`; `app.json` owns its default identity and permissions.
A simulator build does not validate physical-device networking, sign-in or
native permission behavior.

For a signed internal IPA, use a Mac with Xcode, CocoaPods, an Apple Developer
team and a provisioning profile for the selected Bundle ID:

```bash
npm ci
APPLE_TEAM_ID=YOUR_TEAM_ID npm run build:expo:ios:ipa
```

The shared script prebuilds iOS, archives a Release build and exports
`apps/workbench-expo/release/OpenCraft-ios-internal.ipa` with a SHA-256 file.
`OPENCRAFT_IOS_EXPORT_METHOD` accepts `development` (default) or `ad-hoc`;
ad-hoc installation needs registered device UDIDs and a matching profile.
`OPENCRAFT_IOS_RELEASE=1` requires a clean checkout without a generated `ios/`
project. `OPENCRAFT_NATIVE_ARTIFACT_NAME` changes the output prefix for an
explicit product build. Product Bundle IDs, schemes, icons, permission copy
and regional release selectors belong to that product's config, not core
build targets. This script does not export an App Store distribution IPA.

Linux and CI can verify JavaScript packaging without Xcode:

```bash
npm run build:expo:ios
```

This emits `apps/workbench-expo/dist/ios/main.jsbundle` and its assets. It does
not compile CocoaPods, sign an IPA or prove an Apple binary runs.

## Native sign-in

The public default entry does not create a downstream account. A product that
adds native sign-in owns the authorization endpoints, registered OIDC client,
exact callback URLs, region selection, session format and any account SDK.
Configure those in the product's trusted local entry/config and auth service;
changing the core bundle alone cannot enable an external backend contract.

Keep each transaction's random state and PKCE verifier with its credential
owner. Validate the exact callback and state before exchanging a short-lived
one-time code over TLS. Cancellation, replacement and cold-start restoration
must act only on the owning transaction; stale callbacks or 401 responses must
not clear a newer session. Never put session tokens in callback URLs or send
credentials, Bot state or cached account data to another region. A product with
multiple installed editions must use matching Bundle IDs, schemes, callbacks
and signing profiles, then verify callback delivery on physical devices.

The product also owns its packaged Bot DOM runtime and generated login assets.
Prepare them through that product's build tools before selecting its Expo
entry. The shared runner generates only public math/Mermaid assets, plus the
Web Workbench for the explicit experimental Web-container entry. Public builds
do not require private frontend sources or generated Bot HTML. For shared
container and lifecycle invariants see [mobile shell](../../docs/mobile-shell.md),
[embedded Bot bridge](../../docs/mobile-bot-bridge.md) and
[packaged Web Workbench](../../docs/mobile-workbench-container.md).

Update bundled dependency license metadata with
`npm run licenses:generate --workspace @opencraft/workbench-expo` after dependency
changes, and verify it with
`npm run licenses:check --workspace @opencraft/workbench-expo`. Preserve required
third-party notices; a product owns any additional notices for its private
dependencies and assets.

## Android internal APK

Use a JDK 17 and an Android SDK with platform 36, build-tools 36.0.0 and
35.0.0, NDK 27.1.12297006, and CMake 3.22.1.
Set `JAVA_HOME` and `ANDROID_HOME`, then run
from the OpenCraft root:

```bash
npm ci
npm run build:expo:android:apk
adb install -r apps/workbench-expo/release/OpenCraft-android-internal.apk
```

On a network where Maven Central is rate limited, set
`OPENCRAFT_ANDROID_USE_CN_MIRRORS=1` for the build command. This explicitly
selects the checked-in Aliyun/Tencent Gradle repository configuration; CI uses
the default repositories.

The build generates or updates the ignored `android/` directory, bundles the
JavaScript into a standalone release APK, verifies its signature, and writes
`release/OpenCraft-android-internal.apk` with a SHA-256 file. The application
ID is `dev.opencraft.workbench`, version `0.1.0` (Android version code 1). Expo's
generated release configuration signs it with a development keystore for
internal testing only. Bump the version code for a later distributable build.

The manual **Android internal APK** Actions workflow builds this public target
and provides the APK as an artifact. It does not execute a downstream product
or publish to a store or GitHub Release. Installing the APK does not require
Metro; using the Workbench still requires a reachable configured Host.

## Android release APK

公开默认构建使用 `dev.opencraft.workbench`。下游产品可通过显式 Expo 产品配置
提供自己的包名、显示名称和图标；产物文件名前缀由
`OPENCRAFT_NATIVE_ARTIFACT_NAME` 指定，默认是 `OpenCraft`。
正式签名 PKCS12 密钥库和密码文件必须保存在仓库外，并由负责人安全备份；
后续更新同一包名须沿用同一密钥。
使用 Linux、JDK 17 和上文的 Android SDK，设置 `JAVA_HOME`、
`ANDROID_HOME`、`GRADLE_USER_HOME`，再从 OpenCraft 根目录运行：

```bash
export OPENCRAFT_ANDROID_RELEASE_KEYSTORE=/secure/path/release.p12
export OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE=/secure/path/keystore-password.txt
export OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS=opencraft-release
npm --prefix apps/workbench-expo run build:android:release
```

产品包从产品目录运行其构建命令，显式传入产品配置与产物名前缀；
每个包的签名资料从其实际 APK 读取。

构建会重新生成忽略的 `android/` 工程，将 release variant 改为正式签名，
校验 APK 的包名和签名证书。产物位于 `apps/workbench-expo/release/`：

- `OpenCraft-dev.opencraft.workbench-android-release.apk`：默认可安装包，旁边有 SHA-256 文件。
- `OpenCraft-dev.opencraft.workbench-filing.txt`：包名、**签名证书 MD5**、**APK 文件 MD5**、Base64 公钥。
- `OpenCraft-dev.opencraft.workbench-public-key.pem` 和 `-signing-cert.der`：可交接的公钥与公开证书，均不包含私钥。

产品构建的文件名使用产品前缀和实际包名。

备案表若只写“MD5”，先确认要求的是签名证书还是 APK 文件；两者不同。
更换密钥或重新构建 APK 后，应重新从新产物读取这些值，不沿用旧资料。
在有 Android 设备时安装新包验证：

```bash
adb install -r apps/workbench-expo/release/OpenCraft-dev.opencraft.workbench-android-release.apk
```

需要在局域网提供临时下载链接时，让服务在持续运行的终端中启动：

```bash
python3 apps/workbench-expo/scripts/serve-android-release-apk.py \
  --apk apps/workbench-expo/release/OpenCraft-dev.opencraft.workbench-android-release.apk \
  --bind 0.0.0.0 --port 8765
```

提供产品包时将 `--apk` 指向对应 APK。下载路径为所选文件的文件名。

用 `hostname -I` 找到可达的局域网 IP，将
`http://<局域网 IP>:8765/OpenCraft-dev.opencraft.workbench-android-release.apk` 发给测试者。
先用 `curl -I` 检查 HTTP 200 和文件长度，再下载核对 SHA-256。
服务只开放这一个 APK 路径；签名密钥和密码不得放进下载目录。
关闭终端或服务器进程后，链接即失效。该流程不执行上架或公开发布。

## Parallel `/agents-next` Expo Web console

This entry belongs to the downstream product and is not a public core target.
Use that product's documented build command from its own checkout; it owns the
frontend source, generated static assets and `/agents-next/` routing. The normal
`/agents` entry remains independent. Core does not ship a compatibility command
that invokes private frontend builds.

The shared contract uses measured container width and preserves one mounted
DOM runtime across phone, tablet, foldable and desktop layouts. The product
packages its frontend configuration and OpenCraft Web chat locally; it must not
replace native device capability ports with a hosted feature page. Electron
assembly and real-device acceptance remain separate product responsibilities.
