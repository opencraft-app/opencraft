---
id: mobile-bot-dom-runtime-2026-09-30
type: task
scope: Embed the existing LightVela Bot UI code in the OpenCraft iOS app.
triggers: ["mobile Bot", "DOM runtime", "native drawer"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - frontend/src/mobile-dom/entry.tsx
  - frontend/src/pages/marketing/agent-settings-page.tsx
  - opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.3.0
precedence: task
derived: true
---

# Embedded mobile Bot runtime

## goal

Run the existing frontend Bot feature components inside an App-packaged DOM runtime, with a native slide-out drawer for Bot, creation and section navigation. Connect every existing Bot section at once without copying its business UI into React Native.

## non_goals

- Move the account, real-name or payment pages into the Bot container.
- Reimplement individual Bot features as native screens.
- Publish the proprietary frontend bundle to the public OpenCraft mirror or ship a signed IPA in this task.

## requirement_ids / requirement_refs / requirement_excerpt

- Conversation, 2026-09-30: “内置网页代码（原生），提供 runtime 容器跑 dom，而不是打开网页”; “全部功能一次接入”; “嵌入代码，而不是复制。提供容器，而不是再次实现.”
- Conversation, 2026-09-30: “应该允许创建BOT 这块代码也需要容器化”; “从而保持一致.”
- Conversation, 2026-09-30: “希望侧边栏能是这样上浮式的质感”; “这样风格可以和我们的opencraft 桌面版对齐.”
- Conversation, 2026-09-30: “手机上半部分和最下面与app是割裂的”; use `ref/paseo` as a reference for iPhone safe-area treatment.
- Conversation, 2026-09-30: “取消下面的tab，套餐和费用变成个人页面的按钮。个人页面和设置融合。放到侧边栏的左下角，固定的项目，对其桌面版opencraft。”
- External PRD/TAPD identifier: unknown.

## interface_refs / data_structure_refs

- `frontend/src/lib/agent-routes.ts`: existing `AgentSectionId` and section paths.
- `frontend/src/pages/marketing/agent-settings-page.tsx`: all Bot section controllers and content, with `embedded` hiding only its web sidebar.
- `frontend/src/pages/marketing/agents-workbench/AgentsWorkbenchPage.tsx`: existing workbench section.
- `frontend/src/mobile-dom/entry.tsx`: `bot-runtime-ready`, `bot-catalog`, `bot-selection`, `bot-create-state`, `external-navigation` bridge messages and native selection/create host events.
- `frontend/src/pages/marketing/agent-settings-page.tsx`: the native create request invokes the existing `handleCreateNew` flow; the page itself reports whether creation is visible and enabled.
- `opencraft/apps/workbench-expo/scripts/build-mobile-bot-runtime.mjs`: explicit frontend-to-HTML bundle step; generated HTML is ignored and not mirrored.
- Native session token and selected region remain owned by `mobileAccount`; Bot API and repository logic remain owned by frontend.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `opencraft/apps/workbench-expo/README.md`.
- `relevant_evolution`: the first iOS shell loaded remote `/agents` in its main WebView; the user reported blank content and asked to package the existing Bot code locally. Account and billing keep their previously chosen native/web boundaries.
- `superseded_refs`: remote `/agents` as the primary iOS Bot tab.

## acceptance

- The Bot tab loads the generated, App-packaged HTML asset and imports the existing frontend components; after the initial local load, no remote site document (including `/`) may replace it.
- The Gesture Handler/Reanimated `InterruptibleMobileDrawer` opens by button or swipe, lists Bots from the frontend provider, and selects the mobile menu sections. Browser, Terminal and Workbench remain in the DOM runtime but are hidden from the drawer. The drawer's buttons use HeroUI Native. Installed HeroUI Native 1.0.10 has no left-drawer component, so the gesture container is explicitly an exception rather than a HeroUI Native drawer.
- The native drawer uses `BACK` presentation so the existing Bot surface moves above the menu. Its progress drives the content surface radius, shadow and slight scale continuously during drag. Menu material and selection use the shared OpenCraft Native design tokens; the feature rows have native Lucide icons. The App has no bottom Tab bar. Its account and settings entry is pinned below the independently scrolling Bot/feature list, following the desktop OpenCraft Sidecar footer placement.
- The Bot drawer and moving surface fill the iPhone window through the status bar and home-indicator regions. Safe-area insets pad the controls *inside* each full-height surface, so the menu header and pinned account footer remain reachable while the rounded card and background extend edge to edge. The personal and web-detail pages retain safe-area spacing.
- The account entry opens one native personal page with profile actions, a subscription-management button, language controls, open-source notices and developer mode. The existing website remains the owner of detailed account, verification, billing and payment flows. Returning from the personal page goes back to the Bot workspace; returning from web billing goes back to the personal page.
- The drawer's create action uses the existing frontend creation flow, including first Bot onboarding, additional Bot rules, quota limits and subscription routing. Native controls do not submit Bot mutations themselves.
- The native Bot list gives each Bot a profile avatar, status, selected state and a distinct delete affordance. The creation action has its own card hierarchy. The profile shape catalog is shared across web and native; the DOM bridge supplies the current profile choice and refreshes it after an edit.
- The drawer has no extra LightVela title row. Its Bot group heading contains the close action and leads straight into creation and Bot cards, preserving vertical space on phones.
- The local HTML asset is read once during shell startup and reused at Bot mount. Overview is the initial section so the existing frontend data requests start without requiring a manual section switch. Authentication and profile data remain account scoped; only the static bundle is read before login.
- Each Bot row offers deletion through the existing frontend named confirmation dialog, preserving the main Bot sibling restriction and updating native selection after removal.
- Persona cards use the frontend's two-column narrow-container layout; the source label and actions no longer overlap at phone width.
- The frontend repository/session provider receives the native region and session; internal Bot navigation stays in the local DOM runtime. External account/billing routes return to existing App flows.
- Expo Go iOS bundle and external manifest/bundle verification pass. Physical device rendering and authenticated API operation are recorded separately.
- Repeated section switching cannot leave an unhandled blank view: frontend render failures and iOS WebView content-process termination show a branded retry state and record a fixed diagnostic event without error payloads.

## affected_paths

- `frontend/src/mobile-dom/`, `frontend/src/lib/`, `frontend/src/repositories/`, `frontend/src/pages/marketing/agent-settings-page.tsx`
- `opencraft/apps/workbench-expo/`, `docs/engineering/domains/agent-gateway-runtime.md`

## required_context

- Root, OpenCraft and frontend `AGENTS.md`; task template; Expo host and frontend Bot route/component/provider sources; OpenCraft maintenance and Expo preview skills.
- Context router had no matching Pack; bounded exact search located the above owners.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md` | Task and Git boundaries | Task Pack, verification, no commit without approval |
| `opencraft/AGENTS.md` | Native host and preview rules | HeroUI Native shell, package boundary |
| `frontend/AGENTS.md` | Existing frontend ownership | Reuse feature components without reimplementation |
| `docs/context/tasks/TASK-TEMPLATE.md` | Required task fields | This record |
| `opencraft/apps/workbench-expo/README.md` | Device/build instructions | Explicit generated runtime step |
| `frontend/src/lib/agent-routes.ts` | Existing section contract | Native selection bridge |
| `frontend/src/pages/marketing/agent-settings-page.tsx` | Existing Bot controllers | Embedded presentation flag |
| `frontend/next-site/public-site-app-providers.tsx` | Existing provider order | Local DOM provider stack |
| `docs/engineering/domains/site-environment-routing.md` | Region and API ownership | Explicit native-to-DOM site routing |
| `/data/mono2/ref/paseo` at `3cc4ae2`: `packages/app/src/mobile-panels/presentation.tsx`, `components/left-sidebar.tsx` | Read-only reference implementation; this checkout's `ref/paseo` directory is empty | Full-screen panel geometry with insets inside the panel; no Unistyles code reused |
| Expo Safe areas and System bars documentation | Current iOS system UI guidance | Keep controls clear of OS UI while drawing panel surfaces behind it |

## evidence

- `npm run build:mobile-bot-runtime --workspace @opencraft/workbench-expo`: generated 23 MB self-contained HTML from frontend source.
- `npm run typecheck --workspace @opencraft/workbench-expo`: passed after native host integration.
- `npm run bundle:ios --workspace @opencraft/workbench-expo`: passed and copied the generated HTML asset.
- Frontend baseline typecheck: 0 new diagnostics. Native WebView/developer-log tests: 11 passed. Two focused frontend route/navigation files: 18 passed. The large create-intent Vitest worker exceeded the configured 4 GB and 8 GB heaps; its remaining assertions are unverified.
- External iOS manifest and complete bundle downloaded; the generated HTML also downloaded from the Cloudflare URL with the same SHA-256 as the exported asset.
- The first iPhone screenshot showed the original hand-written drawer and feature rows. A later developer log showed `bot.runtime.script.failed` before any ready/auth/catalog event. An offline DOM execution of the generated asset reproduced `ReferenceError: React is not defined`; the bundle used the classic JSX transform. The build now uses automatic React JSX and provides the browser `process.env` values that the imported Next.js modules read. The new smoke command executes the generated module and receives `bot-runtime-ready`.
- The refreshed iOS bundle and external manifest passed, and the updated external HTML asset SHA-256 matched the generated source. Physical iPhone Bot data remains unverified after this correction.
- The new native create action passes an integration smoke check: the generated frontend bundle reports create availability and a create command reaches its existing subscription-aware flow. Authenticated creation still requires a physical device check.
- A physical iPhone screenshot confirms the Bot catalog and section navigation. The Model section failed to read its configuration while the original bundle lacked several Tailwind utility selectors. The build now scans `frontend/` explicitly, and the smoke check requires Model error-card utilities in the generated CSS. The developer log records fixed numeric endpoint and Model load failure categories alongside HTTP status to identify the 403/409 and configuration failure without exposing URLs or responses.
- A reopened Cloudflare preview passed external iOS manifest, full JavaScript bundle and packaged HTML checksum on 2026-09-30. Physical iPhone Model behavior after these changes is pending.
- The native Bot drawer now forwards delete intent to the existing frontend confirmation, and focused component tests confirm that the child Bot name must be entered before the existing `deleteBot` action runs and that the main Bot remains protected while siblings exist. The 17-test onboarding suite passes. The Persona CSS fix removes conflicting Tailwind utility classes that overrode container-query rules from the earlier `app` CSS layer; its layout test and generated CSS checks pass. Physical iPhone layout after refresh is pending.
- The Bot drawer now uses the installed gesture-handler `BACK` presentation and its own native progress value to lift the unchanged content surface with continuous corner, shadow and scale animation. Shared Native material tokens color the exposed menu; icon rows match the desktop navigation vocabulary. Expo typecheck, iOS bundle and external Expo Go manifest/full bundle passed. The exact feel and bottom-tab boundary still need an iPhone check.
- After the iPhone screenshot exposed a hard safe-area seam, the Bot route now gives the native drawer the full window and applies `insets.top`/`insets.bottom` inside the menu and moving surface. This follows Expo's safe-area guidance and Paseo's full-screen panel approach; no Unistyles dependency was added. Expo typecheck, iOS bundle and external manifest/full bundle passed again on 2026-09-30. The updated top/bottom rendering still needs a physical iPhone check.
- The bottom-tab follow-up removes the Tab component and the standalone native billing entry. The drawer's account footer is outside the scrollable feature list; the Bot DOM runtime remains mounted while the personal or subscription page is open. Account includes the existing profile actions, a button to the website-owned subscription flow, and inline language/license/developer settings. Expo typecheck, iOS bundle, external manifest/full bundle and nine focused account/session contract tests passed. The combined page and footer interaction still need an iPhone check.
- A 2026-10-01 iPhone report identified a blank band around the lower rounded screen/Home Indicator region of Chat. The Bot host had reserved the bottom inset outside the embedded Workbench while the composer used zero inset. Chat now occupies the host's full lower edge and the composer owns that inset. The DOM Bot pages retain their host padding. Expo typecheck and iOS bundle validate the source; the lower-edge rendering still needs an iPhone retest.
- On 2026-10-01, the native drawer Bot list and create action were given a card hierarchy, profile avatar and status. Avatar shape definitions now have one shared source; the DOM sends validated profile metadata to native. The generated Bot HTML is pre-read at iOS startup, and Overview is the first embedded section. Protocol tests, frontend typecheck, DOM smoke, Expo typecheck and iOS bundle passed; physical iPhone visual behavior remains to be checked.
- A later iPhone screenshot showed the native Chat still worked while a Bot DOM feature showed the global retry card. The screenshot retained the removed LightVela drawer title, proving it was captured from an older JS bundle. Independently, the host conflated a single DOM section render failure with failure of the entire WebView. Section failures now carry their route ID and only cover that section; another section can recover through the existing DOM boundary. The bridge test covers old/new failure messages, and an offline smoke with a running Bot exercises Overview and repeated feature switching. The original device failure category remains unknown until the developer log is provided.
- WKWebView content-process termination now gets at most two automatic reloads in a one-minute window; repeated termination exposes the manual retry card. A process exit is logged by fixed event name, while native Chat and Bot selection remain owned outside WebView.
- A 2026-10-01 iPhone screenshot showed the live LightVela marketing homepage replacing the bundled Bot UI. The asset was packaged, but the host permanently allowed the site root `/` because it is also the HTML `baseUrl`. The document policy now allows that URL only for the initial local load, blocks later homepage redirects and subframe documents, and remounts the local asset on retry. This restores the packaged-document boundary; the WebView still has network access for APIs and is not a strict sandbox.
- A later iPhone screenshot showed the Files feature with a page-wide horizontal scrollbar. The bundled DOM now has an explicit viewport-width boundary, and the shared file manager uses a narrow two-column list on phones while retaining its three-column layout on larger screens. Horizontal content must stay within its own control, leaving drawer swipes to the native shell.

## risks

- The generated HTML asset is large and fetched by Expo Go separately from the JavaScript bundle. Keep it ignored; measure on a real device before release.
- WKWebView HTML `baseUrl` and authenticated cross-origin API behavior need a physical iPhone check. A successful Metro bundle does not prove live Bot data or mutations.
- The existing creation dialog and onboarding UI are shown inside the DOM container; verify their mobile viewport and keyboard behavior on iPhone.
- The public `opencraft/` subtree lacks `frontend/`; standalone mirror builds cannot regenerate this proprietary runtime. The mono2 iOS build requires the explicit generated-asset step. Do not mirror the generated frontend code by accident.
- Native drawer labels are presentation data; the frontend route registry still owns actual Bot feature behavior. Keep route ID changes synchronized.

## validation

- `npm run build:mobile-bot-runtime --workspace @opencraft/workbench-expo`
- `npm run smoke:mobile-bot-runtime --workspace @opencraft/workbench-expo`
- `npm run typecheck --workspace @opencraft/workbench-expo`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- `node frontend/scripts/typecheck-baseline.mjs`, focused frontend tests, `git diff --check`, change-impact check.
- External Expo manifest via preview skill, then physical device Bot list/section/API observation; routine preview checks do not download the complete bundle.

## decisions

- Native owns only drawer, selection and host navigation; frontend components remain the sole Bot feature implementation.
- Use a generated local DOM asset for Expo Go compatibility. Browser routes for account and billing remain separate per earlier scope.
- Keep the generated asset out of Git because it contains bundled frontend source.

## scan_scope

- `frontend/src/pages/marketing/`, `frontend/src/contexts/`, `frontend/src/lib/agent-routes.ts`, `opencraft/apps/workbench-expo/src/`

## scan_output

- Bounded `rg` selected the Bot route registry, page component, provider stack and native tab owner.

## handoff

- Branch `codex/mobilefirst-account-components-20260930`; changes remain uncommitted. Physical iPhone evidence is still required before claiming all Bot operations work. Commit/push/MR require explicit approval.
