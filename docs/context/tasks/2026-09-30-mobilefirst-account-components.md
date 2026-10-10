---
id: mobilefirst-account-components-2026-09-30
type: task
scope: Share account business logic while keeping independent iOS and website pages.
triggers: ["mobilefirst", "account overview", "OpenCraft iOS"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - opencraft/packages/mobile-account-sdk/src/index.ts
  - opencraft/apps/workbench-expo/src/components/mobile-account-overview.ios.tsx
  - opencraft/apps/workbench-expo/src/components/native-navigation-surface.ios.tsx
  - frontend/src/pages/marketing/account-page.tsx
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.1.0
precedence: task
derived: true
---

# Mobile-first account component

## goal

Share account profile, real-name status and referral data logic between OpenCraft iOS and the LightVela site, while each platform independently renders its account page. Preserve the site's complete account page on mobile.

## non_goals

- Rebuild real-name verification, payment or subscription flows in native code.
- Change Android workbench account UI or ship a signed iOS archive.
- Claim native production bundle splitting from Expo Router's experimental development-only async routes.

## requirement_ids / requirement_refs / requirement_excerpt

- Conversation request, 2026-09-30: use a separate `mobilefirst` branch; share account logic; use HeroUI Native for iOS controls; retain site real-name and payment flows; install a Chinese font for preview. Follow-up correction: restore the original site account page, including invitations; use one SDK and two independent pages.
- Conversation follow-up, 2026-09-30: remove the bottom tabs; merge account and settings on the native personal page, add subscription management there, and pin its entry to the Bot sidebar footer.
- Conversation follow-up, 2026-09-30: make settings right-swipe interactive with a basic animation, create one app-level adaptive navigation motion primitive for native pages, and record the rule in `opencraft/AGENTS.md`.
- External PRD/TAPD identifier: unknown.

## interface_refs / data_structure_refs

- Native profile: `GET /auth/profile` with the region's Bearer session; only the `{ user }` profile is projected.
- Shared account operation contracts: `PUT /auth/profile`, `POST /auth/profile/phone/send`, `POST /auth/profile/phone/verify`, multipart `PUT /auth/profile/avatar`, and `DELETE /auth/session`; hosts provide their own authenticated transport.
- Domestic real-name entry: `/account?open=realname` opens the site's existing verification modal and consumes the query parameter.
- Site profile: `frontend/src/contexts/session-context.tsx` supplies the existing session user.
- Runtime flags: `realnamePhoneVerificationEnabled` controls real-name interpretation; `referralEnabled` controls invitation visibility.
- Referral APIs: `POST /v1/referrals/me/code` and `GET /v1/referrals/me/stats`; the shared SDK normalizes their data for both renderers.
- Shared business logic: `opencraft/packages/mobile-account-sdk/src/index.ts`; the backend remains authoritative for verification and rewards.

## history_context

- `current_design_refs`: `docs/engineering/domains/agent-gateway-runtime.md`, `opencraft/apps/workbench-expo/README.md`, `docs/engineering/domains/identity-access.md`.
- `relevant_evolution`: iOS previously opened all three account-related bottom tabs in one WebView. An initial shared layout hid the site's invitation section behind a details action; the corrected design restores the original site page and keeps only business logic in the SDK.
- `superseded_refs`: none.

## acceptance

- The iOS personal page renders an independent native account view with HeroUI Native actions and invite data when the referral feature is enabled. Nickname, avatar, account ID copy, sign-out and verified domestic phone change are directly available; unverified domestic phone binding opens the site's existing verification flow. The same page includes application settings and a subscription-management button; no bottom tab bar remains.
- The main site renders its complete original account page on mobile, including invitation, profile editing and verification.
- Real-name status, referral payload parsing and profile mutation contracts are shared; verification and payment retain the existing site routes.
- Expo iOS bundle, frontend build/typecheck, focused tests and a mobile-width browser preview succeed.

## affected_paths

- `opencraft/packages/mobile-account-sdk/`, `opencraft/apps/workbench-expo/`, `opencraft/tests/`
- `frontend/next-site/account-page-client.tsx`, `frontend/src/pages/marketing/account-page.tsx`, `frontend/src/repositories/`, frontend workspace configuration
- `docs/engineering/domains/agent-gateway-runtime.md`, `opencraft/apps/workbench-expo/README.md`

## required_context

- Root, OpenCraft and frontend `AGENTS.md`; task template; existing domain design; Expo host and site account implementation.
- Context router returned no matching pack for the task. Bounded search of the Expo app and frontend account page located the owners above.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@8043bed71` | Monorepo task, context and Git boundaries | Isolated branch, Task Pack and verification |
| `opencraft/AGENTS.md@8043bed71` | Expo ownership and style rules | Native host boundary |
| `frontend/AGENTS.md@8043bed71` | Site UI and test rules | Restore the original page and validate its invitation component |
| `docs/context/tasks/TASK-TEMPLATE.md@8043bed71` | Required Task Pack fields | This record |
| `docs/engineering/domains/agent-gateway-runtime.md@8043bed71` | Current iOS WebView ownership | Update the account boundary |
| `opencraft/apps/workbench-expo/README.md@8043bed71` | Existing device and build path | Update account tab behavior |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@8043bed71` | Local maintenance flow | Build and scope checks |

## evidence

- Corrected Expo workspace typecheck and iOS JavaScript bundle passed; the external Expo Go manifest and full bundle download passed after a Metro cache reset.
- Corrected Next.js build generated 105 routes. Focused account/referral tests passed (67), as did the three SDK tests.
- A 390px Chromium preview rendered the restored original site account page without page errors. The local mock has referrals disabled by default; the ReferralSection test verifies the enabled branch.
- Anonymous runtime-config reads on 2026-09-30 reported `referralEnabled: true` for both `api.lightvela.com` and `api.lightvela.ai`.
- Noto Sans CJK SC installed in the local preview environment and verified with `fc-list :lang=zh family`.
- Device installation and live authenticated API traffic remain unverified on this Linux host.
- Follow-up: Expo typecheck and iOS bundle passed; four SDK tests passed; frontend baseline typecheck reported 0 new diagnostics; the focused real-name deep-link test passed. The external Expo Go manifest and full bundle downloaded successfully after these edits.
- Navigation follow-up: the iOS bottom tabs and standalone billing entry were removed. The Bot drawer has a pinned account/settings footer, and the native personal page now contains the subscription-management button and inline settings. Expo typecheck, iOS bundle, external manifest/full bundle and nine focused account/session contract tests passed; updated iPhone visual verification is pending.
- Account polish: the native account page and settings details now accept a left-edge right-swipe back gesture. Account and settings surfaces use OpenCraft's native semantic tokens for canvas, cards, separators, text and accent while keeping HeroUI Native controls and a friendly consumer layout. Expo typecheck and iOS bundle passed; physical iPhone gesture and visual checks are pending.
- Navigation motion follow-up: the prior edge strip only fired a callback after release. `NativeNavigationSurface` now owns enter/return animation, follows the user's drag, springs back below the threshold, and measures the current pane width for phone, iPad or folding layouts. The underlying Bot/account screen stays mounted and visible while the top page moves. Settings licenses/log use a nested instance. The installed HeroUI Native version has no navigation surface with this gesture contract; the container uses Expo Go-compatible Gesture Handler and Reanimated, while its controls remain HeroUI Native. Expo typecheck and iOS bundle passed; real-device motion remains to be checked.
- Preview policy follow-up: user requested faster iteration without downloading the full JS bundle for each new Expo Go URL. `opencraft/AGENTS.md` and the repo preview skill now require only Metro/tunnel and external iOS manifest plus bundle-origin checks by default; `--full` remains for a concrete transfer failure. The new tunnel's manifest and bundle origin passed this light check. This does not establish device rendering.
- Drawer-state correction: the account footer previously closed `ReanimatedDrawerLayout` before opening the native account surface. It now opens the surface directly and preserves the drawer beneath it, so an interactive right-swipe reveals the same open sidebar. Expo typecheck, diff check and the lightweight external iOS manifest/bundle-origin check passed; the user should confirm the return state on device.

## risks

- Native profile contract or region feature flag changes may diverge from the site's session context. Keep parsing strict and treat failed fetches as a retryable account screen.
- The native and website pages can drift in feature coverage. Keep the website page complete and verify the native invitation section against the same feature flag and referral API contract.
- The native SMS and profile mutations have not been exercised with a live signed-in account. The backend and the site share the same paths and payloads, but a physical device check is still needed before release.
- Avatar selection, compression, multipart upload, clipboard copy and sign-out need a physical Expo Go interaction check; a successful JavaScript bundle alone does not establish their iOS behavior.
- The iPhone avatar picker worked but upload failed with a generic error. The upload now uses Expo FileSystem's native multipart PUT transport. A local, bounded developer log records fixed event names, upload byte count and HTTP status without account data; Settings gates its viewer behind Developer mode. The phone retry is pending.
- The account screen requires a live network connection. The WebView and cached static assets do not make private profile data available offline.

## validation

- `npm run typecheck --workspace @opencraft/workbench-expo`
- `npm run bundle:ios --workspace @opencraft/workbench-expo`
- `tsx --test tests/mobile-account-sdk.test.ts`
- `pnpm run typecheck`, account and referral Vitest files, `pnpm run build:next`
- `git diff --check`, change-impact check, mobile-width browser rendering, external Expo Go manifest/bundle check

## decisions

- Share account business logic, API operation descriptions and payload projection. Each platform owns its own view, auth/session and navigation. Owner: implementation team.
- Keep the complete existing site account page, including invitation, identity checks and billing. Owner: implementation team.
- Use HeroUI Native iOS controls and standard React Native layout; do not add Unistyles. Owner: implementation team.
- Keep Expo native async route splitting disabled for production because the SDK 57 feature is development-only. Owner: implementation team.

## scan_scope

- `opencraft/apps/workbench-expo/src/`, `opencraft/packages/`, `frontend/next-site/`, `frontend/src/pages/marketing/`

## scan_output

- Local bounded `rg` results selected the profile endpoint, site account page and existing native tab owner; no broad repository dump retained.

## handoff

- Branch `codex/mobilefirst-account-components-20260930` in `/data/mono2-mobilefirst-20260930`; changes are reviewable but uncommitted.
- A signed iOS build and physical login require a Mac and a real test account. Commit/push/MR require explicit approval under root `AGENTS.md`.
