## goal

After native LightVela sign-in, present the selected domestic or international `/agents` website inside the OpenCraft iOS app and warm public static assets.

## non_goals

- Offline chat or caching private API responses.
- Android and Expo Web renderer changes.
- Production site publication or account-service deployment.

## requirement_ids / requirement_refs / requirement_excerpt

- User request in this session: use the current `lightvela.ai` content as an iOS web shell after login, with proactive caching.
- User clarification: start with website entry and static-asset caching.
- User steering: avoid Unistyles and use NextUI Native (now HeroUI Native) for the iOS shell. The user confirmed the full Android/workbench migration is out of scope for this pass.
- User steering: iOS shell must launch in Expo Go.
- User steering: use the App-specific native login and upgrade the iOS entry UI with HeroUI Native. Expo Go must also support that login.
- User steering: add domestic/international login selection and replace the technical login copy with a branded interface.
- User steering: add an iOS bottom bar for My agents, Account, and Plans & billing, and hide the website's duplicate top navigation in the App.

## interface_refs / data_structure_refs

- `opencraft/apps/workbench-expo/src/runtime/lightvela-account.native.ts`: native session owner.
- `opencraft/apps/workbench-expo/src/runtime/lightvela-site-webview.ts`: first-party token bootstrap and static prefetch boundary.
- `opencraft/apps/workbench-expo/src/app/index.tsx`: iOS site view, with separate Android and Web route files.
- `user/auth/api/native-login.openapi.yaml`: native exchange returns a non-cookie session token.
- `frontend/src/repositories/http-repositories.ts`: website stores that session in `lightclaw-auth-token-v1`.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/build-matrix.md`.
- `relevant_evolution`: Expo already had native PKCE login and an independent native workbench. Android internal APK work is present in the current worktree.
- `superseded_refs`: none.

## acceptance

- iOS bundle includes the site shell and resolves WebView native dependency.
- A signed-in iOS route opens the selected `/agents`; token injection runs only on that region's first-party origin.
- The login page offers domestic/international selection, persists it, and uses the matching auth API and site. Active sessions cannot switch regions without signing out.
- The iOS bottom tabs open the selected region's `/agents`, `/account`, and `/account/billing` in one WebView. Website navigation updates the active tab; the App hides the duplicate site header and keeps mobile Agent sidebar height bounded.
- Both Expo Go and the installed app verify a stored native session before opening the site; an expired session returns to the App login gate.
- Web logout clears the native account; prefetch uses anonymous requests and only first-party versioned static assets.
- Typecheck and focused tests pass. Actual iOS rendering remains a Mac/device check.

## affected_paths

- `opencraft/apps/workbench-expo/`
- `opencraft/tests/lightvela-site-webview.test.ts`
- `opencraft/docs/platform-architecture.md`
- `docs/engineering/domains/agent-gateway-runtime.md`
- `frontend/public/tat-hermes-web-proxy-sw.js`
- `frontend/scripts/tat-hermes-web-proxy-sw-static-cache.test.js`

## required_context

- `site-environment-routing`, `identity-access`, OpenCraft maintenance and build matrix.

## context_receipt

| File | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@2.0.0` | International site boundary | Keep the shell on `lightvela.ai` |
| `docs/context/domains/identity-access.md@2.0.0` | Session ownership | Keep auth exchange with the native account |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | OpenCraft platform work | Preserve platform and state ownership |
| `opencraft/docs/platform-architecture.md` | Current mobile architecture | Record the iOS-only shell change |
| `opencraft/docs/build-matrix.md` | iOS delivery boundary | Distinguish JS bundle from IPA |
| `frontend/AGENTS.md` | Frontend Service Worker boundary | Preserve existing proxy and file download behavior |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | Static asset neighbor | Check build and test neighbors before changing public assets |

## evidence

- `https://lightvela.ai/agents` returned HTTP 200 on 2026-09-29.
- Live versioned JS assets returned `Cache-Control: no-store`, while a CSS asset returned `public, immutable, max-age=31536000`; prefetch therefore cannot promise persistent JS caching on the current site.
- Expo's bundled native module map pins `react-native-webview` to `13.16.1`.
- iOS autolinking resolved `react-native-webview`; `npm run build:expo:ios` bundled 3,631 modules successfully.
- The earlier `npm run gate` passed before the Service Worker bridge. Expo workspace typecheck, platform boundaries, and five focused WebView session/cache tests passed after it.
- HeroUI Native 1.0.10 and Uniwind 1.12.0 are installed. The iOS account gate uses HeroUI Native; the iOS bundle and Expo typecheck pass after integration.
- A local Mac/Xcode IPA archive/export command was added. Linux verified shell syntax and the missing-Xcode guard, but cannot run signing.
- Expo Go and installed iOS builds use the same HeroUI Native account gate; the Expo and shared native chat packages no longer depend on Unistyles or NitroModules.
- Expo Go also skips loading the HeroUI Native account layout; the standalone iOS build loads that layout after checking the execution environment.
- The earlier Expo Go website login path was removed after the user confirmed that the App-specific native login should own authentication. `expo-web-browser` uses iOS `ASWebAuthenticationSession` with the exact registered callback scheme, so the current implementation can return the callback to the active auth session without a separate Expo Go backend client. A physical-device login run still must confirm this behavior.
- Metro served an Expo Go iOS manifest (`exposdk:57.0.0`) and a development iOS bundle (HTTP 200, 19.9 MB) on 2026-09-29. This verifies startup assets can be delivered, not runtime behavior on an iPhone.
- A remote Expo Tunnel served the iOS manifest and bundle, but Expo CLI on that server reported `Not logged in`. Expo's iOS physical-device policy requires Expo Go and Expo CLI to use the same account; an anonymous Tunnel is insufficient for the user's phone test. The anonymous Tunnel was stopped.
- After the user authorized interactive login, Expo CLI reported the expected account. Expo Go reached Metro through ngrok but timed out fetching the 16.4 MB uncompressed iOS bundle. Metro now gzips bundle responses when requested; the same response transfers about 3.0 MB. A temporary Cloudflare HTTPS tunnel fetched the complete compressed bundle in 8 seconds, and its iOS manifest points to the HTTPS tunnel origin. Use an `exps://` link because Expo Go maps `exp://` to HTTP.
- The user preferred the Expo Go development-server list, which disappeared when only the HTTPS tunnel was used. The Expo tunnel was restored for discovery; Metro now redirects its `.bundle` requests to the separate HTTPS tunnel when `OPENCRAFT_EXPO_BUNDLE_ORIGIN` is set. A full GET through the Expo tunnel followed one redirect and downloaded the compressed bundle in 16.6 seconds. The user confirmed the project reappeared in the Expo Go list; runtime launch is still a device check.
- The iPhone then displayed `Failed to get NitroModules`, proving the remote bundle arrived but its startup route loaded Unistyles. The shared Expo Router route files were still present in the iOS route context. The default route and layout now hold the iOS site shell, with platform-specific Android and Web workbench routes; the not-found route no longer imports Unistyles. iOS and Android bundling, Expo typecheck, platform boundaries, and Web export pass after this route change. The restarted Expo tunnel redirects to a new HTTPS tunnel; an external full iOS bundle GET followed the redirect and downloaded 3.0 MB of gzip in 13 seconds (HTTP 200). Phone runtime retest is pending.
- A second iPhone retry still hit NitroModules. Further tracing found that `src/runtime/app-entry.ts` imported Unistyles before Expo Router, and `chat-render-native` also depended on it. Both the Expo workspace and shared native chat renderer now use React Native styles for the legacy workbench; the Babel plugin and both npm dependencies were removed. Production iOS and Android bundles, plus the actual external Metro iOS bundle, contain no `NitroModules` or `react-native-unistyles` text; both affected workspaces typecheck. `npm ci --dry-run --ignore-scripts --offline` proposes removing the two native packages and passes; platform boundaries and `git diff --check` pass. The Expo ngrok tunnel then failed to connect, so Metro now advertises the working Cloudflare HTTPS proxy directly; its iOS manifest and full bundle returned HTTP 200. A new phone run is pending.
- Expo Web export passed after the dependency removal. The repeatable Cloudflare Expo preview is documented in `opencraft/.agents/skills/opencraft-expo-cf-preview/`; its verification script downloaded the current external iOS manifest and full 16.2 MB bundle. The current temporary iOS link is `exps://halo-sic-legend-appropriate.trycloudflare.com`; open it from Safari, with Expo Go installed from the US App Store.
- `npm ci --dry-run --ignore-scripts`, the guarded Expo JSI patch, Expo typecheck, iOS production bundle, Expo web export, platform boundaries, and focused WebView tests passed after dependency restoration.
- The existing site Service Worker now accepts a bounded static prefetch message, caches only same-origin versioned Next.js assets, and leaves private API requests outside its fetch handler. A focused Vitest test passed with a `no-store` response.
- The Service Worker behavior is covered in the frontend Vitest suite; its focused test passed. Frontend `check`, 38 adjacent file/proxy tests, and `build:global` passed. The full frontend test run was stopped after failures in unrelated debug and Skills Demo suites; it did not pass as a gate.
- OpenCraft's five focused site-shell tests, Expo typecheck, platform boundaries, and iOS production bundle passed after the Worker bridge change.
- The Expo Go and installed iOS layouts now share the HeroUI Native App login gate. Source inspection of Expo SDK 57 `expo-web-browser/ios/WebAuthSession.swift` shows `ASWebAuthenticationSession` is initialized with the requested custom callback scheme; the App keeps its exact `opencraft://auth/lightvela` OIDC callback and PKCE exchange. An unauthenticated GET to the live `/oauth2/authorize` accepted `opencraft-native-v1` parameters and returned the first-party authorization page (302 then 200). This does not prove iPhone callback completion.
- After the Expo Go login change, Expo typecheck, 12 focused login/session/cache tests, and iOS production bundling passed. The Cloudflare preview's external manifest and complete iOS bundle returned successfully; iPhone login and WebView display are pending user device evidence.
- The user screenshot shows the HeroUI Native gate in Expo Go. The gate was redesigned with the existing LightVela icon, short product copy, region tabs, and one login action. Live unauthenticated checks returned the domestic `/agents` page (200) and domestic native OIDC authorization redirect (302 to `lightvela.com`). Region-specific session restore, authorization URL, and WebView first-party boundary are covered by focused tests. Expo typecheck, 15 focused tests, platform boundaries, and iOS production bundling passed; the external bundle downloaded successfully after the region change. Device login completion remains pending.
- The user's 16:18 iPhone screenshot shows the signed-in domestic `/agents` site inside Expo Go, so native auth callback and the WebView session handoff worked on that device. The screenshot also shows the website's top header and a tall Agent sidebar, motivating native bottom tabs and scoped in-WebView layout CSS.
- The live frontend's account menu maps the three labels to `/agents`, `/account`, and `/account/billing`; both regional billing pages returned HTTP 200. The iOS bundle, Expo typecheck, focused login/site-shell tests, platform boundaries, and external manifest/full-bundle download passed after bottom-tab implementation. Updated device layout and all three taps are pending user screenshot.
- The user's 16:31 screenshot showed the first native bottom bar's HeroUI Native `Tabs` secondary indicator covering the selected item as a solid purple block. The bar now uses HeroUI Native `Button` components with a compact icon-and-label layout and a small selected accent; `global.css` configures the library's light accent token to the LightVela purple. iOS typecheck/bundle and external manifest/full-bundle checks passed. The new appearance still needs a device screenshot.
- The first device screenshot also showed Chinese site content beneath English tab labels. The WebView now reports the document language with location changes, and the HeroUI Native bottom bar follows it; a focused test covers an in-site language change without a route change. iOS typecheck, bundle, and external manifest/full-bundle verification passed after the update.
- Documentation mapping and change-impact checks passed; the latter identifies `wisp/mono2-maintainers` as the owner for the OpenCraft runtime surface.

## risks

- WKWebView and native OIDC completion require a Mac/device run. Revert the iOS route and WebView dependency if the shell is not accepted.
- The current live Service Worker lacks the new cache logic. A frontend publication is required before JavaScript caching works on `lightvela.ai`; no production publication is authorized in this task.
- Real WKWebView Service Worker persistence and GitHub OAuth completion remain device checks. The local Worker test models Cache Storage but is not a browser persistence test.
- The legacy Android workbench now uses React Native styles with the current light design tokens; this removes dynamic Unistyles theming and retains the previous initial light theme. The iOS installed shell uses HeroUI Native.
- Expo Go callback completion and WKWebView session handoff have iPhone evidence for the domestic `/agents` page. The new bottom-tab layout and three destinations still need a device retest.
- Opening this development build on a physical iPhone also requires matching Expo account sign-in in Expo CLI and Expo Go. A remote server needs its own CLI sign-in or the project must be served from the user's signed-in development computer.
- The temporary remote tunnel depends on its foreground Metro and tunnel processes. Real iPhone loading through the new HTTPS tunnel still requires a device retry; local and external HTTP checks alone do not verify the WebView runtime.
- Expo's patch-level compatibility checker still recommends newer SDK 57 packages. The repository pins Expo 57.0.18 and JSI 57.0.6 because its Xcode 26.2 patch explicitly guards that native version. Expo Go manifest/bundle were verified with those versions.

## validation

- `npm run typecheck --workspace @opencraft/workbench-expo`
- `node --import tsx --test tests/lightvela-site-webview.test.ts`
- `npm run build:expo:ios`
- `npm run build:expo:web`
- `pnpm exec vitest run scripts/tat-hermes-web-proxy-sw-static-cache.test.js` (from `frontend/`)
- `pnpm check` and `pnpm build:global` (from `frontend/`)

## decisions

- Expo Go and installed iOS use the dedicated `opencraft-native-v1` PKCE client in the selected region, verify through that region's `/auth/session`, then hand the token to website storage on that region's exact first-party origin. The backend uses the shared `/oauth2/authorize` page, not a separate native login page.
- Prefetch excludes authenticated API data and page HTML from persistent cache.

## scan_scope

- `opencraft/apps/workbench-expo`, `frontend/src/repositories/http-repositories.ts`, `user/auth/api/native-login.openapi.yaml`.

## scan_output

- Bounded command output in this task's tool history.

## handoff

- Code is local to this worktree. No IPA or production publication is implied.
- WKWebView login, navigation and screenshots still need a Mac/iPhone run. Current live JS cache headers prevent durable JavaScript reuse until the site policy is corrected and published.
