# Workbench Expo

Expo Router host for iOS, Android, and Expo Web. It consumes the same
`@opencraft/workbench-runtime` as the Vite/Electron renderer while keeping a native
view and native composer boundary.

The `workbench-frame.web.tsx` and `workbench-frame.native.tsx` files are host
adapters with a shared semantic component underneath. DOM-only packages such as
ProseMirror and the Codex SCSS frame are intentionally unavailable here.

## 手机端路线

| 要做什么 | 标识与产物 | 从哪里开始 |
|---|---|---|
| iPhone 体验当前代码 | Expo Go 临时预览，依赖持续运行的 Metro | [真机快速体验](#iphone-真机快速体验) |
| Android 内测安装 | `dev.vela.workbench`，开发签名 APK | [Android 内测 APK](#android-internal-apk) |
| Android 正式包与资料 | 中国大陆 `com.tencent.vela`；国际 `com.tencent.vela.intl`，分别生成签名与包资料 | [Android 正式 APK](#android-lightvela-release-apk) |
| iOS 可安装测试包 | 内测 `dev.vela.workbench`；大陆 `ai.lightvela.vela`；国际 `ai.lightvela.vela.intl` | [iOS IPA](#ios-site-shell-and-simulator) |

Expo Go 链接、Android APK 和 iOS IPA 是不同交付物。每次交付都从当前
checkout 构建并验证成品；构建成功本身不代表已经安装、上架或发布。

## iPhone 真机快速体验

当前 iOS 版使用 HeroUI Native 登录页和智能体滑动侧栏，侧栏左下角固定“个人与设置”入口，不显示底部 Tab。智能体设置运行由 `frontend/` 源码构建的本地 DOM 功能容器；“对话”使用 OpenCraft 自有的 RN Chat 和 Composer，连接所选 Bot 的实例与 Profile。个人页合并原生资料与应用设置，并提供“订阅管理”按钮。深入管理账号、实名认证和订阅支付时打开所选站点的现有网页。Android 版仍是独立的 React Native 工作台；它的内测 APK 见下文。

登录页精灵图标内联在首屏 JS 中，避免 Expo Go 通过远程 Metro 再请求一张图片。替换 `assets/lightvela-icon.png` 后运行 `npm run assets:login-mark --workspace @opencraft/workbench-expo` 更新首屏素材。

1. 在 iPhone 上从[美区 App Store 安装 Expo Go](https://apps.apple.com/us/app/expo-go/id982107779)。
2. 让开发者先运行 `npx expo whoami`，确认电脑 Expo CLI 与手机 Expo Go 登录的是同一个 Expo 账号；未登录时在电脑上完成 `npx expo login`。再按 [Cloudflare Expo Go 预览 skill](../../.agents/skills/opencraft-expo-cf-preview/SKILL.md)启动并核验预览，取得本次的 `exps://…trycloudflare.com` 链接。链接每次可能变化；Metro 和 Cloudflare Tunnel 必须保持运行。直连链接不能绕过 iPhone 真机的 Expo 账号校验。
3. 把完整链接粘贴到 **Safari 地址栏**，允许跳转 Expo Go。不要用聊天软件内置浏览器，也不必等待项目出现在 Expo Go 的开发服务器列表。
4. Expo Go 默认进入国际站并登录 LightVela。登录后进入“我的智能体”；打开左侧菜单，从固定的“个人与设置”入口进入个人页。个人页可管理订阅、选择语言和查看开源授权。登录前也能从右上角打开设置。调试大陆站时，在登录前的设置中启用开发者模式，再切换站点。

如果出现红屏或一直加载，请把手机画面发给开发者，并让其检查外网 manifest 与正在运行的 Metro 日志；只有定位到 bundle 传输问题时才检查完整 bundle。此预览是临时开发服务，不能当作已安装的独立 IPA。
如果 Expo Go 提示电脑的 CLI 未登录或账号不同，先让开发者核对 `npx expo whoami`，在电脑上完成同账号登录后，点手机错误页的 **Try Again**；无需把密码发给开发者。只有 CLI 已缓存另一个账号时才需要重启 Metro。

## iOS site shell and simulator

The iOS shell uses HeroUI Native. Expo Go and installed builds use the same App
login flow and website shell. On iOS, `expo-web-browser` uses
`ASWebAuthenticationSession`. Expo Go and the mainland package retain
`opencraft://auth/lightvela`; the international package registers
`opencraft-intl://auth/lightvela` so two installed packages have separate
callbacks. For Expo
account discovery, sign in to the same Expo account in the CLI and Expo Go;
check the CLI account with `npx expo whoami`. The verified `exps://` link above
is the direct entry when the server list does not show the project.

From the repository root, start Metro and scan its QR code with the iPhone
Camera:

```bash
npm install
npm run build:mobile-bot-runtime --workspace @opencraft/workbench-expo
npm run start --workspace @opencraft/workbench-expo -- --go
```

The Bot runtime build requires a mono2 checkout with `frontend/` and
`opencraft/` dependencies installed. It packages the existing frontend Bot
components, providers and styles as local HTML under `apps/workbench-expo/assets/`.
The generated asset contains frontend code and is ignored by Git. Regenerate
it after frontend Bot changes, before starting Metro or building an iOS archive.
The standalone public OpenCraft subtree lacks `frontend/` and cannot
regenerate this private runtime.

If the phone cannot reach the computer over the local network, add `--tunnel`.
Expo CLI may ask to install `@expo/ngrok`. An anonymous tunnel can serve a
manifest but still be rejected by Expo Go on a physical iPhone.

For an HTTPS reverse proxy, set `EXPO_PACKAGER_PROXY_URL` to its public origin
before starting Metro and open `exps://<proxy-host>` in Expo Go. Expo Go maps
`exp://` to HTTP; `exps://` uses HTTPS. Metro gzips `.bundle` responses when
the client accepts gzip, which helps remote phones load the iOS bundle.
If Expo Go's development-server list needs the Expo tunnel, keep `--tunnel` and
set `OPENCRAFT_EXPO_BUNDLE_ORIGIN` to a separate HTTPS proxy for the same Metro
server. Requests for `.bundle` through `exp.direct` then redirect to that proxy;
the manifest and list entry remain on the Expo tunnel.

Open the Expo Go link in Safari on iPhone. Install Expo Go from the US App
Store if it is unavailable in your current storefront. The Expo Go route opens
the App login gate and then the site shell. Test the callback on a physical
iPhone; bundle delivery alone does not prove the auth session completes.

On a Mac with Xcode and CocoaPods installed, build the native development app:

```bash
npm install
npm run dev:expo:ios
```

Expo generates the native project when needed, installs pods, builds the custom
development client, starts Metro, and opens the iOS Simulator. The default
theme is explicitly light. Expo no longer depends on Unistyles or NitroModules;
the Android workbench uses React Native styles, while iOS uses HeroUI Native.

After native LightVela sign-in, iOS verifies the session and loads the
App-packaged Bot DOM runtime. The native session and region are supplied to
the existing frontend repository and session providers before their scripts
run. A local Gesture Handler/Reanimated container provides the interruptible
left drawer, with HeroUI Native controls for Bot and feature selection. Browser,
Terminal and Workbench stay in the embedded runtime but are hidden from the
mobile drawer;
the frontend components execute the feature logic. Account and billing remain
in a separate first-party WebView, and other origins open outside the App.
Android and Expo Web keep their existing workbench renderer.

The iOS shell has no bottom bar. Its native Bot drawer owns navigation and
keeps the Account and settings entry fixed at the lower left. The account page
uses `@opencraft/mobile-account-sdk` for profile, verification, nickname and
safety-phone rules, with an independent native presentation. When referrals
are enabled, it shows the invite link and reward counts and opens the iOS share
sheet. It can edit the nickname, change the avatar, copy the account ID, sign
out and, for verified domestic accounts, change the safety phone. Avatar
selection uses Expo Go compatible image modules, compresses the photo and
uploads it through the existing profile API with Expo FileSystem multipart PUT.

The account page opens the first-party website for full account management,
real-name verification and Subscription management. The website stays mounted
beneath the native account surface so those routes appear without a blank
intermediate page. The native Bot runtime also stays mounted while the account
is open; returning reveals the drawer in its previous state. Settings and
open-source notices are native pages within the account flow. Settings is also
available before sign-in from the login gate. The packaged Bot runtime omits
the website sidebar because the native drawer owns mobile navigation. A
versioned `@opencraft/mobile-bot-bridge` contract carries Bot selection, create,
delete, refresh and external navigation between those two runtimes. See
[mobile shell](../../docs/mobile-shell.md) and [embedded Bot bridge](../../docs/mobile-bot-bridge.md)
before changing either side.

The native Settings screen offers Follow device, Simplified Chinese, and
English. The choice is saved locally and translates the App shell. Before a
first-party WebView page starts its JavaScript, the App writes the selected
locale to the website's existing `lw-locale` and `lw-locale-explicit` keys;
changing it reloads the current page so the website's own i18n can apply it.
International Simplified Chinese maps to the site's published `zh-SG` locale.
The mainland China website currently remains Chinese even if the App shell is
English. No session token or language value is sent to another origin. Add
future native translations in `src/runtime/mobile-language.ts` and expose a
locale only after both App and website have a complete dictionary.

For iPhone diagnostics, open Settings, enable Developer mode, then open
Diagnostic log. It keeps only the latest 100 lines on the device across app
restarts. Logs contain fixed event names and numeric facts such as HTTP status
and upload size; they exclude tokens, account IDs, paths, request bodies and
response text. Normal account errors remain plain user-facing messages.

Settings also contains an offline list of this Expo app's direct open-source
dependencies, with their versions and license identifiers from the workspace
lockfile. Each row opens the upstream package page for full terms; a separate
button opens LightVela's complete open-source notice. Run
`npm run licenses:generate --workspace @opencraft/workbench-expo` after changing
app dependencies and `npm run licenses:check --workspace @opencraft/workbench-expo`
to verify the bundled list.

The WebView warms a small set of first-party, versioned static assets for nearby
`/agents/` pages without requesting private API data. It registers the site's
existing Service Worker, which explicitly stores versioned Next.js assets in
Cache Storage and serves them on later visits. This bypasses the live site's
`Cache-Control: no-store` on JavaScript chunks without caching chat or API
responses. Until that Service Worker change is published to `lightvela.ai`,
prefetch falls back to the ordinary HTTP cache and JavaScript reuse is limited.
Native archive, signing, and device verification still require a Mac with Xcode.

For a signed internal IPA on a Mac with Xcode, CocoaPods, an Apple Developer
team, and a provisioning profile for `dev.vela.workbench`, run:

```bash
npm ci
APPLE_TEAM_ID=YOUR_TEAM_ID npm run build:expo:ios:ipa
```

The script prebuilds iOS, installs pods, archives a Release build, and exports
`apps/workbench-expo/release/OpenCraft-ios-internal.ipa` with a SHA-256 file.
Set `OPENCRAFT_IOS_EXPORT_METHOD=ad-hoc` for registered test devices; the
default is `development`. Apple signing and device installation cannot be
verified on Linux.

要构建 LightVela 标识的 iOS 测试 IPA，在干净 checkout 的 Mac 上设置
`OPENCRAFT_IOS_RELEASE=1`，并提供对应 Bundle ID 的 Apple Developer Team。
默认大陆包 `ai.lightvela.vela`：

```bash
OPENCRAFT_IOS_RELEASE=1 APPLE_TEAM_ID=YOUR_TEAM_ID \
  OPENCRAFT_IOS_EXPORT_METHOD=ad-hoc npm run build:expo:ios:ipa
```

该命令生成 `apps/workbench-expo/release/LightVela-ios-internal.ipa`；
国际包使用另一份干净 checkout，设置
`OPENCRAFT_LIGHTVELA_EDITION=intl`，Bundle ID 为 `ai.lightvela.vela.intl`，
产物为 `LightVela-International-ios-internal.ipa`。两包需要各自的签名配置。
`ad-hoc` 需要测试设备 UDID 和有效的签名配置。现有脚本只导出 development
或 ad-hoc 测试包，不会生成 App Store 分发 IPA。Mac、Xcode、CocoaPods
与 Apple 签名缺一不可；Linux 上的 JS bundle 检查不能代替 IPA 验证。

## Native LightVela login

The iOS app uses the existing `GET /oauth2/authorize` page and
`POST /auth/session/exchange`. The release edition fixes the default site:
`OPENCRAFT_LIGHTVELA_EDITION=cn` (the release default) uses `api.lightvela.com`,
`lightvela.com/agents` and `opencraft://auth/lightvela`; `intl` uses
`api.lightvela.ai`, `lightvela.ai/agents` and
`opencraft-intl://auth/lightvela`. Expo Go retains the development identity,
defaults to international, and uses the existing `opencraft://` callback.
The site override is available only after enabling Developer mode in Settings,
before sign-in. A signed-in session must sign out before changing sites; tokens
never cross regions. Installing a different edition resets a saved region
override to that edition's default.
Explicitly register OIDC client `opencraft-native-v1` with both exact native callbacks on each production auth service before testing the international release. Deploy a backend version that accepts both callbacks before changing `AUTH_OIDC_CLIENTS_JSON`; the previous backend accepts only the original callback. The shared login page owns provider selection; native never selects Google directly. The server must support these endpoints and the API gateway must allow them
without an existing session. Updating this app alone cannot enable that backend
contract; an unavailable backend must not fall back to session tokens in URLs.

The account owns the PKCE transaction (random verifier/state in SecureStore,
10-minute lifetime), validates the exact callback and state, then exchanges the
short-lived one-time code over TLS. Completion/cancellation compare-deletes only the owning transaction, through a process-wide serialized SecureStore adapter.
Cold-start callbacks restore the pending transaction; the callback route returns
to `/` and never owns credentials. Stale callbacks cannot suppress a saved session. The generic web login flow is unchanged. Native OIDC grants live for 120 seconds and are redeemed only through the first-party session adapter, not as site-gateway JWTs.

The matching server contract is `user/auth/api/native-login.openapi.yaml` in the
LightVela mono2 repository. No production deployment is implied by a simulator build.

CI and Linux hosts can verify the complete JavaScript bundle and native package
discovery closure without Xcode:

```bash
npm run build:expo:ios
```

This emits `dist/ios/main.jsbundle`; it does not compile CocoaPods or boot an
Apple binary.

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
ID is `dev.vela.workbench`, version `0.1.0` (Android version code 1). Expo's
generated release configuration signs it with a development keystore for
internal testing only. Bump the version code for a later distributable build.

Once OpenCraft is mirrored to its standalone GitHub repository, the manual
**Android internal APK** Actions workflow builds the same target and provides
the APK as an artifact. The nested workflow does not execute in mono2 and does
not publish to a store or GitHub Release. Installing the APK does not require
Metro; sign-in still requires the native LightVela login server contract
described above.

## Android LightVela release APK

正式 Android 分为大陆包 `com.tencent.vela`（默认）和国际包
`com.tencent.vela.intl`（设置 `OPENCRAFT_LIGHTVELA_EDITION=intl`）；
显示名称和图标分别来自同一套 Expo 源码。
Expo Go 与内测 APK 仍使用 `dev.vela.workbench`。正式签名 PKCS12 密钥库和
密码文件必须保存在仓库外，并由负责人安全备份；后续更新同一包名须沿用同一密钥。
使用 Linux、JDK 17 和上文的 Android SDK，设置 `JAVA_HOME`、
`ANDROID_HOME`、`GRADLE_USER_HOME`，再从 OpenCraft 根目录运行：

```bash
export OPENCRAFT_ANDROID_RELEASE_KEYSTORE=/secure/path/lightvela-release.p12
export OPENCRAFT_ANDROID_RELEASE_PASSWORD_FILE=/secure/path/keystore-password.txt
export OPENCRAFT_ANDROID_RELEASE_KEY_ALIAS=lightvela-com-tencent-vela-release
npm run build:expo:android:release
```

国际包在另一份干净 checkout 中用相同命令构建，但增加
`OPENCRAFT_LIGHTVELA_EDITION=intl`，并使用为国际包保管的正式签名密钥。
两包的签名资料分别从各自 APK 读取。

构建会重新生成忽略的 `android/` 工程，将 release variant 改为正式签名，
校验 APK 的包名和签名证书。产物位于 `apps/workbench-expo/release/`：

- `LightVela-com.tencent.vela-android-release.apk`：可安装包，旁边有 SHA-256 文件。
- `LightVela-com.tencent.vela-filing.txt`：包名、**签名证书 MD5**、**APK 文件 MD5**、Base64 公钥。
- `LightVela-com.tencent.vela-public-key.pem` 和 `-signing-cert.der`：可交接的公钥与公开证书，均不包含私钥。

国际包对应的文件名前缀为 `LightVela-com.tencent.vela.intl`。

备案表若只写“MD5”，先确认要求的是签名证书还是 APK 文件；两者不同。
更换密钥或重新构建 APK 后，应重新从新产物读取这些值，不沿用旧资料。
在有 Android 设备时安装新包验证：

```bash
adb install -r apps/workbench-expo/release/LightVela-com.tencent.vela-android-release.apk
```

需要在内网提供临时下载链接时，让服务在持续运行的终端中启动：

```bash
python3 apps/workbench-expo/scripts/serve-android-release-apk.py --bind 0.0.0.0 --port 8765
```

提供国际包时加 `--edition intl`，下载路径相应变成
`/LightVela-com.tencent.vela.intl.apk`。

用 `hostname -I` 找到可达的内网 IP，将
`http://<内网 IP>:8765/LightVela-com.tencent.vela.apk` 发给测试者。
先用 `curl -I` 检查 HTTP 200 和文件长度，再下载核对 SHA-256。
服务只开放这一个 APK 路径；签名密钥和密码不得放进下载目录。
关闭终端或服务器进程后，链接即失效。该流程不执行上架或公开发布。

## Parallel `/agents-next` Expo Web console

From `opencraft/`, run `npm run build:agents-next --workspace @opencraft/workbench-expo`.
Then start the frontend dev server and visit `/agents-next/`. From `frontend/`,
`npm run build:agents-next` performs the same preparation; run it before a
frontend release build that includes this experimental entry. Both workspaces'
dependencies must be installed. The generated `frontend/public/__expo-agents/`
assets are ignored and rebuilt from source. The official `/agents` entry stays
in place.

Navigation/session controls are shared HeroUI Native components. Phone/tablet/
foldable/desktop layouts use measured container width and preserve one mounted
DOM runtime. This console embeds the existing frontend configuration code and
OpenCraft Web chat locally; it does not mount RN Chat or a hosted feature page.
Electron can consume the Web mount port after wiring its host capabilities;
that existing entry is not migrated by this change.
