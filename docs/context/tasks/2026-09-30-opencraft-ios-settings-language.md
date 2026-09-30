---
id: opencraft-ios-settings-language-2026-09-30
type: task
scope: Native iOS settings, open-source notices, and website language handoff.
triggers: ["OpenCraft iOS settings", "mobile language", "WebView locale"]
owner: opencraft
authority: primary
source_of_truth:
  - opencraft/apps/workbench-expo/README.md
  - opencraft/apps/workbench-expo/src/runtime/mobile-language.ts
status: active
reviewed_at: 2026-09-30
review_due: 2026-12-29
revision: 1.0.0
precedence: task
derived: false
---

## goal
Add a native iOS settings entry, local open-source license inventory, and a language choice that drives the App shell and the embedded LightVela website.

## non_goals
- No Android UI migration, website translation rewrite, production publication, or iOS native signing.
- The App's bundled inventory lists direct Expo dependencies; it does not replace each upstream license text or LightVela's full site notice.

## requirement_ids / requirement_refs / requirement_excerpt
- User request on 2026-09-30: “增加一个设置按钮，把做一个开源授权页面…另一个是设置语言…App 自身怎么做国际化以及注入现有的 web 页面”.

## interface_refs / data_structure_refs
- `frontend/src/i18n/index.ts`: website reads `lw-locale` and `lw-locale-explicit` before i18n initialization.
- `frontend/src/i18n/locales.json`: international simplified Chinese is published as `zh-SG`; mainland site is fixed to Chinese.
- `opencraft/apps/workbench-expo/src/runtime/lightvela-site-webview.ts`: first-party-only WebView JavaScript boundary.
- `opencraft/package-lock.json`: dependency version and license metadata for the bundled direct-dependency inventory.

## history_context
- `current_design_refs`: `opencraft/apps/workbench-expo/README.md`, `opencraft/docs/platform-architecture.md`.
- `relevant_evolution`: iOS already has a HeroUI Native login gate and three-tab website shell; tab labels previously followed the website document language.
- `superseded_refs`: none.

## acceptance
- Settings opens before and after login while preserving the current website page behind it.
- After login, the bottom tab bar remains visible on Settings and open-source notices.
- Settings offers Follow device, Simplified Chinese, and English; the choice survives app restart.
- Native copy follows the choice; the international website receives its existing locale keys before JavaScript initialization and reloads after a change.
- A first-party origin guard prevents language injection into external pages; mainland website behavior remains clear.
- The open-source screen shows direct app dependencies and license identifiers offline, with links to package terms and LightVela's full notice.
- Expo typecheck, iOS JS bundle, focused locale tests, notice freshness, documentation and diff checks pass.

## affected_paths
- `opencraft/apps/workbench-expo/` source, scripts, dependency inventory and README.
- `opencraft/tests/lightvela-site-webview.test.ts`, `opencraft/tests/mobile-language.test.ts`.
- This Task Pack.

## required_context
- Root Context Router returned no pack for “OpenCraft iOS Expo native settings language internationalization WebView injection open source licenses”; bounded exact search located the Expo shell and frontend i18n authority.
- Root and OpenCraft `AGENTS.md`, OpenCraft maintenance Skill and its verification checklist were read.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Root task and delivery authority | Task Pack and validation boundaries |
| `opencraft/AGENTS.md` | Local platform rules | Expo and HeroUI Native constraints |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Platform maintenance method | Scope and test evidence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Verification matrix | Expo-focused checks |
| `opencraft/apps/workbench-expo/README.md` | Current mobile runbook | User-visible behavior and limitation |
| `frontend/src/i18n/index.ts` | Website language authority | Existing storage keys and reload behavior |
| `frontend/src/i18n/locales.json` | Published locales | `zh-SG` mapping |

## evidence
- The iOS WebView injects session and mobile shell JavaScript before content load; its three-tab bar is native and already tracks site navigation.
- The website's i18n module reads `lw-locale` and `lw-locale-explicit`; its own language switcher reloads some pages to update an initialization-only SDK.
- The Expo workspace has 33 direct external dependencies with version and license metadata in `package-lock.json`.
- Focused WebView/language tests passed 10/10; Expo workspace typecheck and Linux iOS JavaScript bundle (4,608 modules) passed.
- Generated notice inventory freshness passed for 33 direct dependencies; documentation validation returned zero errors and zero broken first-party links; `git diff --check` passed.
- Cloudflare Quick Tunnel external verification passed after the final source change: iOS Expo manifest and complete 16,323,330-byte bundle downloaded from the same temporary HTTPS origin. Metro and tunnel were left running for phone acceptance.
- Device feedback found that the signed-in Settings full-screen modal obscured the bottom tabs. Settings now renders in the tab content area with the WebView still mounted behind it; the pre-login settings entry retains its modal.
- After that fix, Expo typecheck and focused WebView/language tests passed; Cloudflare external verification downloaded the updated iOS manifest and complete 16,323,905-byte bundle.
- Initial `npm ci` failed when `node-pty` tried to extract Node headers with `fchown` on this host. `npm ci --ignore-scripts` installed JavaScript dependencies for the checks above; no native iOS archive was attempted.

## risks
- Website locale injection must remain first-party only and must run before website JavaScript; exact-origin tests cover the boundary.
- The mainland website currently uses Chinese; setting an English App shell does not translate that website.
- A direct-dependency list is not a complete legal attribution for transitive packages; retain links to upstream terms and the complete LightVela notice.
- Native iPhone sign-in and signed-in settings layout need physical device acceptance after the JS bundle check.

## validation
- Focused WebView language tests, Expo typecheck and iOS JS bundle.
- License inventory freshness check, documentation validator, `git diff --check`.

## decisions
- Keep the native language preference local to the App; use existing website locale keys instead of DOM text replacement.
- Start with Chinese and English native dictionaries. The list can expand when both native and website dictionaries are complete.
- Keep the current WebView mounted while native Settings and licenses are open.
- Render signed-in Settings and licenses above the WebView but below the persistent bottom tabs; reserve the modal for pre-login settings.

## scan_scope
- Expo iOS shell, runtime, README, frontend i18n storage and site open-source notice paths.

## scan_output
- Bounded exact searches and file reads are recorded in the evidence above.

## handoff
- Implementation is in an isolated worktree based on `origin/master`. The user explicitly authorized commit, push, and merge into master on 2026-09-30.
- The user confirmed the signed-in Settings tab is visible on iPhone. Language persistence after restart and the signed-in site language after selection remain for device acceptance. The verified Expo Go manifest/bundle proves remote JavaScript delivery, not a signed IPA.

## stage
Source, automated checks, external Expo Go bundle verification, and the reported iPhone Settings layout acceptance complete; GitLab delivery requested.

## verified
- Expo typecheck, iOS JavaScript bundle, external Expo Go manifest and complete updated bundle, focused tests, license inventory freshness, documentation links, and diff whitespace checks passed.

## unverified
- Language persistence after iPhone restart, Apple-signed IPA, and production website language response after selection.

## discard
- A second website translation system or DOM text replacement; the first-party website's existing locale store is used.

## restore
- Worktree: `/data/mono2-ios-settings-20260930`; base `origin/master` at `728f32f22`; root checkout contains unrelated dirty work and was not edited.

## next_action
- Submit the focused change set through a GitLab merge request into `master`, then report the merge commit and any remaining device checks.
