# Workbench Expo

Expo Router host for iOS, Android, and Expo Web. It consumes the same
`@opencraft/workbench-runtime` as the Vite/Electron renderer while keeping a native
view and native composer boundary.

The `workbench-frame.web.tsx` and `workbench-frame.native.tsx` files are host
adapters with a shared semantic component underneath. DOM-only packages such as
ProseMirror and the Codex SCSS frame are intentionally unavailable here.

## iOS site shell and simulator

The iOS site shell uses HeroUI Native and can open in Expo Go. On a physical
iPhone, Expo Go and the Expo CLI serving the project must be signed in to the
same Expo account. Sign in on the development computer first, then sign in to
Expo Go on the phone. Check the CLI account with `npx expo whoami`.

From the repository root, start Metro and scan its QR code with the iPhone
Camera:

```bash
npm install
npm run start --workspace @opencraft/workbench-expo -- --go
```

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

Expo Go opens `https://lightvela.ai/agents` as a website and lets the website
handle its own sign-in. GitHub authorization stays inside the WebView so its
cookie and callback can return to the site. Google rejects embedded browsers;
Expo Go prompts for GitHub or guest access instead. Expo Go cannot register
the custom `opencraft://` native OAuth callback. Use a development build for
the native login flow and Google sign-in.

On a Mac with Xcode and CocoaPods installed, build the native development app:

```bash
npm install
npm run dev:expo:ios
```

Expo generates the native project when needed, installs pods, builds the custom
development client, starts Metro, and opens the iOS Simulator. The default
theme is explicitly light. Expo no longer depends on Unistyles or NitroModules;
the Android workbench uses React Native styles, while iOS uses HeroUI Native.

After the native LightVela sign-in, iOS opens `https://lightvela.ai/agents` in
an embedded WebView. The native session is copied into the first-party page's
existing browser token store before its scripts run; other origins are opened
outside the WebView and never receive that session. Web sign-out clears the
native session. Android and Expo Web keep their existing workbench renderer.

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

## Native LightVela login

The native build uses the existing `GET https://api.lightvela.ai/oauth2/authorize` page and
`POST /auth/session/exchange`, with the fixed callback `opencraft://auth/lightvela`.
Explicitly register OIDC client `opencraft-native-v1` with that exact callback alongside the existing site-gateway client. The shared login page owns provider selection; native never selects Google directly. The server must support these endpoints and the API gateway must allow them
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
