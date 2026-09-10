# Workbench Expo

Expo Router host for iOS, Android, and Expo Web. It consumes the same
`@opencraft/workbench-runtime` as the Vite/Electron renderer while keeping a native
view and native composer boundary.

The `workbench-frame.web.tsx` and `workbench-frame.native.tsx` files are host
adapters with a shared semantic component underneath. DOM-only packages such as
ProseMirror and the Codex SCSS frame are intentionally unavailable here.

## iOS simulator

Unistyles 3 uses Nitro/Fabric native code, so this app cannot run in Expo Go.
On a Mac with Xcode and CocoaPods installed, run from the repository root:

```bash
npm install
npm run dev:expo:ios
```

Expo generates the native project when needed, installs pods, builds the custom
development client, starts Metro, and opens the iOS Simulator. The default
theme is explicitly light.

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
