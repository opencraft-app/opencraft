---
id: mobilefirst-account-checkpoint-2026-09-30
type: task
scope: Recovery state for the mobile-first account component task.
triggers: ["mobilefirst account checkpoint"]
owner: mingyuxiao
authority: derived
source_of_truth:
  - docs/context/tasks/2026-09-30-mobilefirst-account-components.md
status: active
reviewed_at: 2026-09-30
review_due: 2026-11-30
revision: 1.0.0
precedence: task
derived: true
---

# Mobile-first account checkpoint

## stage

The original site account page has been restored after feedback about missing invitation. The shared SDK now also owns nickname and safety-phone operation contracts; the independent iOS page exposes those edits and a direct site real-name entry. Edits are reviewable on `codex/mobilefirst-account-components-20260930`.

## verified

- The mature website account page includes `ReferralSection`, guarded by `referralEnabled`, and uses the referral code/stats APIs.
- The site route now mounts its original `AccountPage` again; the shared package contains only business logic.
- The iOS page renders account details and, when enabled, invitation counts and the system share action using the same referral payload mapping.
- Expo typecheck and bundle, three SDK tests, 67 focused site tests and the Next.js 105-route build passed. A 390px Chromium preview of the restored site page had no page errors.
- The Expo Go quick tunnel returned a valid iOS manifest and complete bundle after Metro was restarted for the package rename.
- The follow-up Expo typecheck and bundle, four SDK tests, frontend baseline typecheck and focused website real-name deep-link test passed; the external Expo Go tunnel served the updated full bundle.
- After an iPhone reported a blank Manage account screen despite a transition animation, the iOS shell was changed to keep the WebView laid out beneath the native account overlay. Expo typecheck, iOS bundle and external manifest/full-bundle download passed again, and the user confirmed the account content is visible.
- The user confirmed Manage account now shows the site page. Native avatar change, account ID copy and sign-out were then added to the account page. Expo and frontend typechecks, SDK tests, iOS bundle, license inventory and external preview download passed; the three new controls still need real-device interaction evidence.
- iPhone feedback showed the picker succeeded but avatar upload failed. The upload now uses Expo FileSystem's native multipart PUT with the shared field name; Settings has a persisted Developer mode and a local 100-line diagnostic viewer. Logs contain fixed event names and numeric facts only, while the account page keeps a plain user-facing error. Awaiting a phone retry to establish the live outcome.
- The user then reported My agents blank. The iOS WebView now records bounded load/HTTP/DOM health events, preserves the selected tab across transient URLs, and offers a native Reload action on load failure or a persistently empty document. It still needs the iPhone diagnostic log to identify the root cause.
- The iOS Billing tab now shows a native “Subscription management” entry and opens the selected site's existing `/account/billing` page only after the user chooses it. Website renewal and payment remain there; iPhone click-through is pending.
- Both current public runtime-config endpoints returned `referralEnabled: true` on 2026-09-30.
- Noto Sans CJK SC remains installed in the local preview environment.
- Account and settings detail screens now have left-edge right-swipe back navigation. Their canvas, cards, separators and text follow OpenCraft native tokens with HeroUI Native controls; Expo typecheck and iOS bundle passed. A device gesture/visual check is pending.
- The edge gesture now uses a shared `NativeNavigationSurface` with drag progress, spring cancellation, matched button return and pane-width layout updates. Account and settings detail screens use it; Bot and account remain behind the moving surface. The old callback-only edge strip was removed. Expo typecheck and iOS bundle passed; verify the interactive feel on iPhone/iPad.
- Preview policy now skips full bundle downloads for routine links per user instruction. The repo `AGENTS.md`, preview skill and README were aligned; the current Cloudflare tunnel passed the lightweight iOS manifest/bundle-origin check. The real phone result remains unverified.
- iPhone feedback found the Bot sidebar vanished when returning from settings. The footer had explicitly closed the drawer before opening account; this close was removed, preserving the open drawer under the animated account surface. Expo typecheck and the lightweight tunnel check passed; device confirmation is pending.
- iPhone recording then showed the account surface flashing between its complete layout and a short loading layout during profile refresh. The shell now computes the account session scope before mounting its view, which synchronously reads the same-session profile cache on its first frame. The native account view retains profile content while refreshing or on transient errors, uses card-shaped placeholders on a true cold entry, keeps the referral card's last successful content during refresh, and only changes the avatar image key after an upload. Real-name actions wait for the current response. `opencraft/AGENTS.md` now gives agents a five-state loading checklist and device validation sequence; the detailed data contract cites TanStack Query and TkDodo guidance. A fresh iPhone check is still needed.

## unverified

- Real iPhone login, native profile/referral fetch, nickname/phone mutation and signed IPA need a Mac, Xcode and a test account.
- No production deploy or native production async route splitting was performed.

## discard

- The previous summary-page screenshot and its shared layout; the user rejected that reduced website experience.

## restore

- Worktree: `/data/mono2-mobilefirst-20260930`.
- Main implementation paths and commands are listed in `2026-09-30-mobilefirst-account-components.md`.
- The branch remains uncommitted. The temporary Expo Go preview tunnel and Metro are running on port 8082.

## next_action

- Reproduce avatar upload and My agents on iPhone, inspect Developer mode logs for failures, and verify the Subscription management handoff. Git commit/push/MR still require explicit authorization.
