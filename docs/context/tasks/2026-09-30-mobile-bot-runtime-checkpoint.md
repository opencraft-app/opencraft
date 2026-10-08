---
id: mobile-bot-runtime-checkpoint-2026-09-30
type: task
scope: Recovery state for the iOS embedded Bot runtime task.
triggers: ["mobile Bot runtime checkpoint"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/tasks/2026-09-30-mobile-bot-dom-runtime.md
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.1.0
precedence: task
derived: true
---

# Embedded Bot runtime checkpoint

## stage

The iOS Bot workspace now loads a generated local HTML bundle of the existing frontend Bot components. A Gesture Handler/Reanimated `InterruptibleMobileDrawer` with HeroUI Native controls selects Bots, invokes the existing Bot creation flow, and shows 16 of the 19 section routes. Browser, Terminal and Workbench remain in the runtime but are hidden from the drawer. The bottom tabs are removed; a fixed account/settings footer opens a native personal page with a subscription-management button and inline settings. Changes are uncommitted on `codex/mobilefirst-account-components-20260930` in `/data/mono2-mobilefirst-20260930`.

## verified

- `build:mobile-bot-runtime` generated 23,225,348 bytes from frontend source; it is Git-ignored.
- Expo typecheck and iOS export bundle passed. The copied HTML asset SHA-256 matches the generated source.
- External Expo Go iOS manifest and full bundle passed; the external HTML asset downloaded with a matching SHA-256.
- Frontend baseline typecheck reported 0 new diagnostics. OpenCraft WebView and developer-log tests passed (11). Two frontend navigation test files passed (18 tests); the large create-intent Vitest worker exceeded both 4 GB and 8 GB heap in this environment, so that file is not a pass.
- Static route comparison originally confirmed all 19 frontend route IDs; the latest mobile menu intentionally hides Browser, Terminal and Workbench, leaving 16 visible.
- Change-impact check and staged diff whitespace check passed.
- The first iPhone screenshot confirms the native drawer, menu and section rows render. A later developer log shows the local asset loaded, followed by `bot.runtime.script.failed` before the frontend reported ready; the timeout followed that failure.
- An offline execution of the generated HTML reproduced `ReferenceError: React is not defined`. The build now uses automatic JSX transformation and provides the small browser `process.env` shim needed by imported Next.js modules. `smoke:mobile-bot-runtime` reaches `bot-runtime-ready` with the actual bundled frontend components. The iOS bundle and external manifest passed again, and the external HTML asset checksum matches the new generated asset.
- The native drawer now uses the frontend page's own creation availability and calls its `handleCreateNew` flow. The generated runtime smoke test dispatches the native create event and observes the existing `/subscribe` route when the test session is unsubscribed; no Bot creation mutation is duplicated in native code.
- A later iPhone screenshot confirms the authenticated Bot catalog and feature selection render; the Model section displays a configuration load error. Its screenshot shows the compiled utility CSS was incomplete, and the developer log shows HTTP 403/409 without request category. The build now scans `frontend/` for Tailwind classes. Diagnostic events include fixed numeric endpoint and Model load failure categories without URLs or response bodies. The exact failing endpoint and server cause remain pending the refreshed device log.
- On 2026-09-30, a fresh Cloudflare preview passed external iOS manifest, full 16,537,567-byte bundle, and external HTML SHA-256 comparison (`4831508f10a97f44eaf8bded83c7b39285fe5f3a3322f0b15c4738f0685951c9`). Embedded runtime smoke, Expo typecheck, iOS export and focused developer-log test also passed.
- The user then reported that native Bot deletion was absent and the Persona screen had overlapping source/heading text with four narrow card columns. Native delete now opens the existing frontend named confirmation and falls back to another Bot after catalog removal. The Persona CSS rules existed, but later Tailwind utility classes overrode their container-query declarations because `styles.css` is imported into the earlier `app` layer; removing those conflicting classes lets the shared responsive rules apply. The full 17-test onboarding suite, including native delete and main Bot protection, passed. The new iOS export, external 16,539,183-byte JavaScript bundle, and generated/external HTML SHA-256 comparison (`56dd02608dccffaab1b36dc4a565598a7f1641200ae6cb9ccb17b12a8bae57b7`) passed. Physical device verification is pending.
- The user then identified that the left drawer container itself was hand-written (`Animated.View` and `PanResponder`), despite HeroUI Native buttons inside it. Installed HeroUI Native 1.0.10 has no left drawer; the implementation now uses `react-native-gesture-handler` ReanimatedDrawerLayout as the gesture, overlay and animation owner. `opencraft/AGENTS.md` explicitly forbids mislabeling this pattern. Expo typecheck passes; refreshed iPhone gesture verification is pending.
- The user reported that repeated section taps eventually left the Bot content blank. The exact device cause is not yet available; ordinary section changes now keep `AgentSettingsPage` mounted to avoid repeatedly rebuilding its controllers. The embedded frontend catches render failures and the iOS host detects WKWebView content-process termination. Both show the existing retry state and write a fixed developer-log event without exposing exception text. Refreshed device verification is pending.
- The generated runtime smoke now switches through Model, Persona, Skills and Channels twice and confirms the root remains mounted without a render-failure event. Rebuilt local DOM asset: 23,227,029 bytes. Expo iOS bundle and frontend baseline typecheck pass (0 new diagnostics).
- The Bot panel is now full-screen with safe-area padding inside the moving surface and sidebar; its status-bar/home-indicator background moves with the card. After the user's follow-up, the bottom Tab bar and standalone native billing entry were removed. The account entry is pinned under the menu ScrollView, the personal page embeds language, license and developer settings, and subscription management opens the website-owned billing route. The Bot DOM runtime stays mounted while these pages are open. Expo typecheck, iOS bundle, nine account/session tests and external manifest/full bundle passed on 2026-09-30. Current preview JavaScript bundle is 16,785,999 bytes.
- On 2026-10-01, the native Bot list became a card list with Bot avatar, lifecycle status and a separate delete target; creation uses a primary card. Frontend and Expo now consume one shared avatar shape catalog, and the profile bridge sends validated shape/color data to native after loading or editing. The static 23,229,415-byte HTML is read once at iOS shell startup; Overview is the initial Bot section. Expo and frontend typechecks, bridge tests, DOM smoke, iOS export, boundary check, diff check and external manifest passed. The manifest check did not download the full bundle, per current preview policy.
- A follow-up iPhone screenshot showed an unused LightVela header above the Bot group. The brand row was removed and its close control moved beside the Bot group label, leaving the safe-area inset and pinned account footer intact. Expo typecheck and iOS export were rerun; physical layout confirmation is pending.
- A subsequent screenshot showed Bot DOM retry while native Chat remained usable. The screenshot still had the removed brand header, so it came from an older JS bundle. The host's section-error handling was corrected: only the failing feature gets a retry overlay, and switching features no longer leaves the whole DOM workspace blocked. The bundled runtime also passed an offline smoke with a running Bot and multiple section switches. The device's first failure mechanism still requires its developer log; an asynchronous request for the last events is pending.
- iOS content-process termination now attempts up to two automatic WebView reloads within one minute, then yields to the existing manual retry. This is separate from section render failure, so a crash does not silently retry forever. Device log confirmation and a physical retest are pending.

## unverified

- Physical iPhone Persona layout, delete confirmation and Model section after the CSS correction, plus classified 403/409 diagnostics and create dialog/onboarding. The revised Bot card list, avatar refresh and Overview startup timing need device verification. The new full-screen safe-area treatment, fixed account footer and merged personal page also need device verification. Authenticated Bot catalog and section selection are now observed on the user's device.
- A signed IPA and standalone public-mirror iOS build. The public subtree lacks `frontend/` and intentionally does not contain the generated HTML.

## risk

- If WKWebView gives the generated HTML an opaque origin, the production API rejects CORS preflights from `Origin: null`; diagnostics record whether DOM origin matches the selected site. Native `baseUrl` is set to the selected site, but only a device can establish its actual security origin.
- The generated HTML is about 23 MB before transport compression; the App bundle and first Expo Go download are larger.

## restore

- Source entry: `frontend/src/mobile-dom/entry.tsx`; build: `opencraft/apps/workbench-expo/scripts/build-mobile-bot-runtime.mjs`; native shell: `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`.
- Metro port 8081 with Cloudflare Quick Tunnel. The current iOS manifest was checked on 2026-10-01 at `exps://tumor-throwing-dryer-cho.trycloudflare.com`; the full bundle was not downloaded. Reverify before sharing; tunnel URLs may change.

## next_action

- Inspect the user's phone result, resolve any opaque-origin/auth or rendering problem, then update validation evidence. Commit/push/MR require explicit authorization under root `AGENTS.md`.
