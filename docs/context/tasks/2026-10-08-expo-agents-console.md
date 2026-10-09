# Expo adapts the current /agents console

## goal
Reuse the current `/agents` controller and OpenCraft Web chat in a local DOM runtime, with shared Expo navigation/session presentation and a parallel `/agents-next` Expo Web entry. Actual container geometry supports phone, foldable, tablet and desktop layouts without resetting product state.

## non_goals
- Replace official `/agents` or migrate the existing Electron entry this iteration.
- Replace configuration forms with independently implemented native business logic.
- Remove the standalone RN workbench or change backend permissions.
- Publish, commit, push, or change production.

## requirement_refs / requirement_excerpt
- User, 2026-10-08: replicate `/agents` in Expo; sidebar and appropriate DOM controls become native.
- Latest steering: use OpenCraft Web chat, suspend the RN chat for this entry.
- `wiki/prd-docs/2026-10-08-agents-bot-rail.md` at `3fa43b017`: Bot switching starts a new chat; legacy overview resolves to chat.

## interface_refs / data_structure_refs
- `frontend/src/mobile-dom/entry.tsx`: persistent frontend controller and native navigation adapter.
- `frontend/src/pages/marketing/agent-settings-page.tsx`: Bot permissions, creation/deletion and session ownership.
- `frontend/src/pages/marketing/opencraft-embedded-workbench.tsx`: Web chat and session commands.
- `opencraft/packages/mobile-bot-bridge/src/index.ts`: generation-scoped validated wire contract.
- `opencraft/apps/workbench-expo/src/components/mobile-bot-host.ios.tsx`: native shell; never navigate the document to a hosted page.

## history_context
- current_design_refs: `opencraft/docs/mobile-shell.md`, `opencraft/docs/mobile-bot-bridge.md`.
- relevant_evolution: `/agents` now has a persistent console layout, Bot rail and chat default. The earlier Expo entry deliberately diverted chat to RN; that choice is superseded for this entry by the user.
- superseded_refs: RN ownership paragraphs in the mobile bridge and Expo agent guidance.

## acceptance
- One packaged frontend controller, one Web chat application for the selected physical instance/Profile.
- Native navigation and session commands project the controller's state; server permissions stay authoritative.
- Chat code/styles bundled locally; no remote module or hosted page required to mount it.
- Phone and wide-pane layout changes preserve selection and chat runtime.
- Protocol, typechecks, bundled DOM smoke and iOS bundle pass; runtime evidence does not claim iPad hardware validation.

## affected_paths
- `frontend/src/mobile-dom/`, `frontend/src/pages/marketing/agent-settings-page.tsx`.
- `opencraft/apps/workbench-expo/`, `opencraft/packages/mobile-bot-bridge/`, focused tests and design docs.

## required_context / context_receipt
Router returned no matching pack; bounded exact search used the entry paths above.

| File at 3fa43b017 | Reason | Use |
|---|---|---|
| `AGENTS.md`, `frontend/AGENTS.md`, `opencraft/AGENTS.md` | Local boundaries | No publication; source and generated copy ownership |
| `frontend/DESIGN.md` | UI rules | Preserve real composer and responsive layout |
| `opencraft/apps/workbench-expo/AGENTS.md` | Native contracts | Persistent drawer, safe area and bridge |
| `opencraft/docs/mobile-shell.md`, `opencraft/docs/mobile-bot-bridge.md` | Current architecture | Reuse navigation; update superseded chat ownership |
| `shared/lightvela-agent-core/AGENTS.md`, `README.md` | Shared policy | No platform convenience in domain core |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | Maintenance workflow | Focused verification and evidence |
| `docs/context/tasks/TASK-TEMPLATE.md`, `.agents/context/change-impact.json` | Handoff contract | Task record and formal design update |

## decisions
- User owns renderer decision: Web chat for this Expo entry; standalone RN renderer remains available elsewhere.
- Existing controller owns state/mutations; native shell is a projection and command adapter.
- Embed the existing custom element build locally, rather than copy its React tree or fetch a hosted artifact.

## evidence / validation
- Clean source baseline except preexisting generated `frontend/next-env.d.ts` change.
- Source audit completed; implementation and focused verification pending.

## risks
- WebView keyboard/viewport behavior requires iPhone/iPad observation; no fixed keyboard heights.
- Bundling OpenCraft adds asset size; this first integration favors local deterministic ownership.
- Generated mono2 copy synchronization needs a committed frontend revision; do not forge its provenance.

## scan_scope / scan_output
- Bounded source inspection of the entry, console, chat element and bridge. No secret scan output copied.

## handoff
Implement local Web chat packaging, native session projection, update ownership documentation and verify.

## checkpoint (2026-10-08)
- Latest scope: a real Expo Web `/agents-next`, keeping `/agents`; adaptive layout uses actual container width across phone/foldable/tablet/desktop. No device-name branches or layout keys.
- Shared HeroUI Native navigation/session presentation extracted; native Web Chat entry and generation-scoped session port implemented.
- Expo Web mount/update/dispose port and Next adapter implemented, build verification ongoing.
- Frontend typecheck: 166 current, 171 baseline, zero new diagnostics. Expo typecheck passes.
- Packaging guard found a Rolldown self dynamic import; inspecting the emitted module before allowing any executable network fetch.
- No publication. The preexisting generated `frontend/next-env.d.ts` stays uncommitted; Next dev updates its route-type path for the isolated preview directory.

## handoff checkpoint (2026-10-08)

### implemented
- Shared HeroUI Native Bot/session navigation; both native host and Expo Web mount it.
- Native console Chat now uses the packaged original OpenCraft Web custom element; no RN Chat in this entry.
- `/agents-next` Next route mounts the actual Metro Expo Web export. Next owns authentication/navigation only; the packaged frontend controller owns Bot/session/entitlement decisions.
- Web update/dispose port prevents profile refresh from resetting the console; container resize changes only layout. Host visibility updates preserve the controller and hide inactive Chat.
- Validated session operations reuse existing handlers, stale generations are rejected, late retired controller completions do not mutate current state, projections fit the bounded wire envelope.
- Local script/style/worker packaging, executable-network CSP, safe diagnostic events and generic user errors.
- `AGENTS.md`, mobile design, formal runtime design and build workflow updated.

### latest evidence
- Expo typecheck passes. Frontend baseline: 166 current / 171 baseline, zero new diagnostics.
- `build:agents-next`: Metro Web export passes; HTML contains packaged Chat and frontend code (about 32 MB before transport compression).
- `bundle:ios`: passes (4,789 modules).
- Bridge tests: 7 pass; shell geometry/navigation model tests: 8 pass.
- Packaged DOM smoke: original Web Chat element mounts, repeated feature switching and existing creation flow pass. Backend is a deliberate 503 fixture.
- Actual Expo Web Shell browser probe: 8 continuous widths, frame/runtime/draft preserved, native-style session command reaches DOM, zero page errors.
- Actual Next `/agents-next` browser probe: Expo Shell, local frontend and OpenCraft Web element mount, zero page errors; backend is a 503 fixture, not a real account/transport test.
- `git diff --check` passes. Change-impact check passes using an isolated temporary index (real staging untouched).
- Root documentation/catalog scans encounter missing files in unrelated sparse checkout service directories; no unrelated files added to satisfy them.
- Lightweight external Expo manifest contains launchAsset; current Metro and CF units active. No full bundle download performed.

### remaining acceptance / limitations
- Real account session operations and WebView keyboard/viewport need device observation; browser fixture cannot prove live Hermes streaming or iPad/foldable keyboard behavior.
- User explicitly excluded Android standalone/Electron entry wiring. Complete the existing Expo App and `/agents-next` shared presentation scope; device testing remains distinct from model/browser evidence.
- Artifact size and initial startup remain optimization work; local deterministic code ownership is established first.
- Frontend check/test/build and source-revision mirror synchronization remain pre-MR work; no commit or publication requested.
- Public preview uses normal auth; no fixture credentials belong in user preview services.

## Bot navigation correction
- Current frontend `AgentBotRail` is the reference: Expo now uses a native/shared vertical avatar rail beside the selected Bot feature/session pane, rather than the obsolete full-width Bot cards.
- Creation is the rail plus action; name/status and deletion remain in the selected Bot header. Accessible labels include Bot name/status and selected state. Bot and feature lists scroll independently; account footer stays fixed.
- Bot icon selection keeps the drawer open. Feature/session selection still dismisses the narrow overlay; geometry uses the existing container-driven Shell. Drawer capacity increased to fit both columns instead of clipping the menu.
- No Android standalone or Electron wiring added.
- Browser probe caught RN Web ignoring `accessibilityState.selected`; the shared rail also supplies the supported `aria-selected` alias. Retrying browser acceptance after this fix.
- Final rail evidence: Expo typecheck, Metro Web export, iOS bundle (4,790 modules), and eight shell geometry/navigation tests pass. Browser probe confirms vertically aligned Bot icons/create button, selected accessibility state, Bot switching keeps the narrow drawer open, session selection closes it, eight widths retain runtime/draft, zero page errors. Backend remains fixture-only.
- Preview services: normal-auth Next dev `opencraft-agents-next-dev-20261008-v2` on 5179 and frontend CF tunnel active. Lightweight HEAD `/agents-next/` returns 200; Expo manifest verified without downloading its bundle.
- Web preview: https://measures-newest-extended-integrating.trycloudflare.com/agents-next/
- Expo Go preview: exps://probably-has-identical-grades.trycloudflare.com

## Chat blank-page investigation (2026-10-09)
- Router query `Expo agents-next preview stuck loading local DOM runtime` matched no Pack; bounded entry/bootstrap/layout searches plus frontend-runtime adjacency/config neighbor inspected. Preview services active; user's screenshot confirms native Shell with white Chat, not dead CF tunnel.
- Initial browser fixture injected its bootstrap into every `<head>` literal, including strings inside bundled JS, corrupting its own HTML. Correcting the fixture to insert once shows original packing parses without errors; the speculative serializer change was removed. Full-document parsing is retained in smoke so VM-only execution does not hide future HTML boundary failures. Direct blank-page cause is the embedded container height chain below.
- Embedded frontend omits `lv-agent-settings-main`/`lv-agent-settings-shell` chrome classes. Existing override targeted those absent classes. A corrected browser fixture removes only the four new allocation rules from the final artifact: Chat measures height 0 at all five tested sizes. With the rules included, its height is 504/788/532/504/164 at viewport sizes 390x740, 768x1024, 1024x768, 500x740 and 390x400. The fixture deliberately returns 503 and its entitlement error occupies 236px; these are layout evidence, not live transport acceptance.
- Embedded Chat now allocates the actual main/section/grid/content flex chain within measured viewport; no device-specific height. Complete packaged HTML parses, both existing modules execute, Web Chat mounts, original feature/creation flows pass the smoke. Browser probe has zero page errors and requests no executable resource beyond its local document.
- `build:agents-next` regenerated the packaged HTML and Expo Web export. Expo typecheck passes; frontend typecheck has zero new diagnostics. Final iOS bundle passes (4,790 modules), lightweight external manifest passes without bundle download; iPhone rendering/live session confirmation remains separate.
- Public `/agents-next` investigation found local unauthenticated route hydrates while CF route remains skeleton-only and Next rejects its HMR connection. Current isolated dev service explicitly opts in the exact tunnel hostname using development-only `NEXT_DEV_ALLOWED_ORIGINS`; it also uses the existing same-origin `local-proxy` API target to avoid CORS against direct API URLs. After restart, the actual public browser reaches the normal sign-in gate, HMR connects, API requests stay same-origin and page errors are zero. No fixture auth is enabled. This proves the unauthenticated entry, not a real signed-in transport.
- Context receipt extended with `docs/context/domains/site-environment-routing.md` and its formal design for the development routing change. Syntax/config checks cover development inclusion and production exclusion of the opt-in domain. Change-impact and whitespace checks pass; no commit, push or publication performed.

## Checkpoint: native OpenCraft multi-tab pane (2026-10-09)

- Latest requirement: the right sidebar is OpenCraft Chat's multi-tab file/tool detail pane, not Bot navigation. Reuse its existing code, state and lifetimes while moving host layout and controls to shared Expo presentation.
- Context receipt: revisited `AGENTS.md`, `opencraft/AGENTS.md`, Expo `AGENTS.md`, maintenance skill, `mobile-shell.md`, `mobile-bot-bridge.md`, original panel model/service/RightPanel/App/custom-element sources, `design/invariants.md`; prior routed frontend service/adjacency receipt remains applicable.
- `workbench-panels/host-presentation` is a pure projection/command/geometry contract. Original `WorkbenchPanelService` owns tabs, close/MRU, preview replacement, resources and admitted actions. External chrome is explicit opt-in; original standalone Web/Electron keeps its toolbar.
- Shared Expo surface uses HeroUI Native Tabs/Dialog/Button. Browser/file bodies remain original renderers in a sibling outlet of the same local custom element. Overlay portal root stays outside both Chat and pane so hiding either does not hide menus/dialogs. No second Application, per-tab WebView, hosted page fallback or copied resource logic.
- Actual host content width determines overlay versus parallel layout, using existing panel minimum and Chat reserve. Runtime generation, instance/Profile and conversation owner are all checked; execution rechecks current tab/action admission. Catalog refs admit sequential catalog/state messages without depending on React render timing. Switching Bot clears the old projection.
- Dependency work: frontend pnpm required a local file dependency for the pure panel contract. Retained only the package-manager generated entries for that dependency closure and preserved unrelated locked versions. Frozen/offline install passes; npm lock updated as well.
- Evidence so far: 31 focused tests pass (bridge, panel service/order, host geometry/admission, embedded presentation); Expo/Web/panel typechecks pass, frontend baseline has 166 current / 171 allowed diagnostics, zero new. Actual exported Expo Web fixture exercises native chrome outside the DOM iframe: open/select/close/reorder/launch/full-width/restore/back; 8 width changes retain runtime and draft, zero browser page errors. This deterministic port fixture does not prove live file reads, browser transport or iPhone touch/keyboard/accessibility.
- Current bundled DOM smoke mounts the real locally packaged Web Chat plus reused frontend feature/create flows. Final regenerated build/bundle and lightweight preview check are recorded below; no commit/push/publication.
- Final delivery evidence: regenerated `build:agents-next` passes; native toolbar uses shared 56-point chrome and 44-point touch targets. Existing browser New-tab titles use the original locale catalog. Final iOS bundle passes (4,793 modules); repeated packaged DOM smoke and actual exported Expo Web fixture pass, with no remote executable imports in the packaged DOM.
- Metro and both CF tunnels remain active. External iOS manifest and bundle-origin check passes without downloading the bundle. URLs unchanged: `exps://probably-has-identical-grades.trycloudflare.com`, `https://measures-newest-extended-integrating.trycloudflare.com/agents-next/`.
- Formal change-impact passes via a separate temporary index, leaving real staging untouched. Documentation validator reports repository sparse-checkout omissions (missing unrelated service entry files and 51 unrelated first-party links); derived coverage has no missing/invalid files. These omissions are not repaired or represented as a passed global documentation gate.

## Correction: native container, original complete right pane (2026-10-09)

- User clarified that only the outer right-pane container should be native; original internal tabs, menus and contents must remain. Previous native Tabs/Dialog implementation violated this scope and could display an empty tab manager when no tabs/actions were available. Removed that replacement UI.
- Expo now measures the same persistent DOM plane with zero extra native toolbar clearance. The shell toggle closes the overlay and returns to Chat. Original RightPanel retains its toolbar, launchers and contents; external layout ignores standalone Shell header spacers and reads full-width intent from the original panel owner.
- Context receipt: root/OpenCraft/Expo AGENTS, maintenance skill and verification checklist, panel bridge/Shell/invariants/runtime design, original RightPanel and panel service; router reported no match and bounded panel-source searches established ownership.
- Previous exported Shell fixture verified replacement native controls, not preservation of the original pane. Acceptance now needs the actual original RightPanel toolbar/menu in the exported host plus empty, tab switching/close and continuous resize cases; synthetic renderer resources remain distinct from live file/browser transport.

- Additional steering: removed the left navigation header X and its unused onClose prop in both Expo iOS/Web hosts. Existing shell toggle, dismiss/selection paths and iOS gestures remain.

- Corrected acceptance: actual exported Expo Web hosting the original RightPanel, AppShell and WorkbenchPanelService passes empty-menu, launcher, tab-menu switch, tab switching, close/disposal, maximize/restore and return. Eight container widths preserve the Chat draft, tab-local input and runtime identity; zero page errors and no replacement native dialog. Resource viewers are explicit synthetic fixtures, so live file/browser I/O and iPhone gestures are not claimed.
- Restored toolbar error paths use a localized generic retry message and a fixed developer diagnostic event; synthetic internal details do not appear in the original pane.
- Final rebuild and verification: Expo/Web/panel typechecks, Expo Web export, packaged DOM smoke and iOS bundle (4,793 modules) pass; 31 focused panel/bridge/presentation tests pass. Whitespace and formal change-impact checks pass (temporary index only). Existing sparse documentation omissions remain as recorded above.
- Metro/Next/tunnels stay active; lightweight external iOS manifest passes without bundle download. Preview URLs remain unchanged; Expo Go reload is needed for the new layout. No commit, push or production changes.

## Daily/Explore native Tabs (2026-10-09)

- Router query `Expo sidebar daily explore HeroUI Native Tabs` matched no Pack; bounded search found two Button controls in the shared navigation. Read Expo AGENTS, existing Shell design, maintenance skill, and installed HeroUI Native Tabs contract/examples.
- User sequence: open navigation → Explore → Daily; expect library Tabs styling/indicator and selected semantics, existing group/session filtering, unchanged selected Bot/feature and persistent Chat/draft. Replace only the controls with controlled HeroUI Native Tabs/List/Indicator/Trigger/Label/Content; no additional business model or DOM implementation.
- Both Expo iOS and `/agents-next` consume this shared component. Final Expo typecheck, Web export, actual exported Web interactions/geometry and iOS bundle (4,793 modules) pass. Lightweight external manifest passes without bundle download; whitespace and formal change-impact pass using an isolated temporary index. No Git delivery requested; hardware interaction remains unverified.

- Browser probe corrections: waited for ready catalog/frame rather than the always-mounted Tabs; use the rendered primitive presentation role instead of CSS class names consumed by Uniwind. Current check observes no expected indicator shift; inspect actual measured bounds before accepting animation. Types/Web export/iOS bundle pass, preview manifest available.

- Root cause: agents-next's Metro entry override replaced the Uniwind resolver, bypassing its React Native Web component adapters. Tabs rendered as a vertical list with an in-flow indicator. Delegate all non-entry requests to the existing resolver and include app-local HeroUI style sources alongside the workspace-hoisted location; do not copy Tabs styles into the feature. An intermediate fixture regeneration also doubled the asset prefix; corrected that fixture/manifest generation, not application routing.
- Actual Expo Web export passes Daily/Explore selected semantics, group/session filtering, indicator motion, keyboard Enter and 44-point touch targets at widths 390/520/1024/1200. Resize probes wait for the host geometry transaction before opening a drawer. Runtime ID, Chat draft and feature-selection count remain unchanged. No page exceptions; the library's colorKit logs Web color-conversion warnings for derived hover colors, recorded as a remaining press-feedback compatibility concern rather than suppressed. Synthetic DOM data does not prove live transport or iPhone interaction.

## Left-sidebar native component audit (2026-10-09)

- Source receipt: shared navigation/session components, iOS drawer container and installed HeroUI Native 1.0.10 Avatar/Menu/ListGroup contracts. Left navigation layout and scrolling already use React Native; feature/Bot/create/select controls use HeroUI Native Button, rename uses Input, confirmations use Dialog, category switching now uses Tabs. DOM only supplies the original controller's validated business projection.
- This audit proposed Menu, Avatar, ListGroup, Spinner and Separator migrations. The user subsequently authorized them; implementation and verification are recorded below under Sidebar primitive migration. The separate virtual-list proposal remains outstanding.
- List performance is a separate gap: session rows are mapped in ScrollView. Introduce a native virtualized list when session capacity requires it, retaining stable chat IDs, pagination, scroll position and the single transient-menu owner. Do not label ScrollView as a DOM issue or use HeroUI ListGroup as a virtualization substitute.
- Preserve Bot avatar SVG shapes/color from the shared profile model; default Avatar cannot erase configured identity. Keep Bot icon rail and fixed account footer, and use the existing RNGH/Reanimated drawer because the installed library has no Drawer. No rewrite of embedded Bot features or Chat/right-panel internals is implied by this audit.

## Sidebar primitive migration (2026-10-09)

- User authorized Menu, Avatar, ListGroup, Spinner and Separator migrations. Router query `Expo left sidebar HeroUI Native Menu Avatar ListGroup Spinner Separator` matched no Pack; bounded shared navigation/session searches and the installed library implementation/types/contract established the scope. Existing root/OpenCraft/Expo AGENTS and Shell design remain applicable.
- Acceptance sequence: open a session menu → dismiss → another session menu → rename/cancel → pin/unread → delete/cancel; keyboard Escape/arrow navigation and return to the trigger on Web; resize with the menu open; account image succeeds/fails/changes then navigate/re-enter. Only the original frontend session commands execute; editing a title is independent of the transient menu owner, and background list projection does not overwrite the draft.
- Menu positioning, overlay and press actions use HeroUI Native. The installed Menu supplies native portal accessibility but has no browser Escape/roving/focus-scope implementation; the small Web focus adapter composes existing Radix primitives while Menu keeps open state and positioning. Browser-only imports stay out of native graphs. One menu ID belongs to the list; a closing old row cannot clear another row's menu. Separate rename/delete Dialog lifetimes avoid the closing menu stealing editor focus.
- Avatar uses the library Image asChild slot with expo-image memory/disk cache and library Fallback. Stable URI sources and disabled Avatar entry animation preserve the current cache behavior. ListGroup owns feature/account row slots; Bot avatar SVG/configuration, rail selection and footer placement remain. Spinner replaces native ActivityIndicator in these two sidebar components; Separator replaces the rail/footer border lines.
- The actual exported Expo Web fixture passes Menu dismiss/Escape/return focus, arrow navigation, pin/unread, rename draft retention across projection refresh, delete cancel/confirm and collisions at widths 390/520/1024/1200. Avatar success, same-URI reuse, failure fallback and URI replacement pass; Chat draft and runtime ID survive these interactions and resizes. No page exceptions. This synthetic browser fixture does not prove live transport or native hardware/accessibility behavior. No virtual-list rewrite, Git delivery or production action requested.
- Browser probe corrections: Menu.Trigger exposes an augmented ref rather than a browser HTMLElement, so focus restoration stays with Radix FocusScope's saved trigger. Arrow navigation observes asynchronous focus completion. DismissableLayer needs its own DOM wrapper with `display:contents`: delegating its pointer capture to React Native Web Menu.Content drops the capture handler and treats internal clicks as outside. The final probe verifies Rename receives clicks and the closing menu does not steal editor focus. Web-only focus imports remain excluded from native resolution.
- Measurement evidence: the real Menu context retains probe layout `{x:0,y:800,width:240,height:204}` while its own positioned DOM is at top 388. RN Web's ResizeObserver does not emit a second size event for a position-only change, so HeroUI 1.0.10's `y < screenHeight` readiness check never enables animation or pointer events. A pinned, idempotent postinstall patch changes readiness to valid measured dimensions in the installed source/module forms; Menu's original primitive still owns positioning. No fabricated coordinates, arbitrary delay or forced pointer events. The patch refuses unknown library versions/source patterns and must be reviewed/removed when upstream fixes this.
- Declared the Web adapter's existing Radix dependencies in the Expo workspace and regenerated the mobile open-source license inventory; license consistency check passes.
- Final source verification: Expo typecheck and Web export pass; iOS release JS bundle passes with 4,794 modules and the updated license asset. Both preview services and tunnels are active; lightweight external iOS manifest/origin check passes without downloading the bundle. Runtime behavior on an iPhone still requires device observation.
- Whitespace and formal change-impact checks pass using a temporary index, without staging the real worktree or including `frontend/next-env.d.ts`. The catalog is regenerated; the global Context validator still fails on existing sparse-checkout missing paths and other repository-wide findings. It is not reported as a passing gate or repaired in this UI task.

## Pinned navigation categories (2026-10-09)

- User requested Daily/Explore remain pinned while the drawer panel scrolls. Router query `Expo sidebar Daily Explore Tabs pinned scroll panel` matched no Pack; bounded inspection of the shared navigation component shows Tabs.List was inside the feature/session ScrollView. Existing mobile Shell design and Expo guidance apply.
- Keep one HeroUI Native Tabs owner. Move its List outside the bounded feature/session ScrollView and let Tabs.Content retain the current projection/commands inside it. Bot header and account footer remain fixed; Bot rail keeps its independent scroll capacity. No duplicated sticky controls or scroll listener state.
- Acceptance: scroll a long session list and long Explore groups in narrow/wide containers; category switch and footer stay visible at unchanged coordinates, the list moves, switching categories still filters correctly and the Chat runtime/draft survives.

- Verification: actual exported Expo Web fixture with 40 sessions and 7 Explore groups passes at widths 390/520/1024/1200. Scroll offsets exceed 1,700 while category tabs and account footer coordinates stay unchanged. Category selection, runtime ID and Chat draft remain intact; no page exceptions. An initial fixture exceeded the protocol limit of 8 groups and was rejected; corrected synthetic data rather than weakening the boundary. Expo typecheck, Web export and iOS bundle pass. Device touch scrolling remains unverified.

## False session failure projection (2026-10-09)

- User observed an operation failure message below an otherwise populated session list. Router query `frontend Agent Console session error operation incomplete native sidebar` matched identity-access only through the ambiguous `session` trigger; read that Pack and frontend AGENTS, then inspected the bounded console projection, pagination hook and embedded session callbacks. This is conversation UI state, not identity/session authorization.
- Source cause: `useAgentSessionPagination.pageError` is a boolean initialized/reset to false. The native projection checked `pageError !== null`, which is true for both false and true, forcing `error: true` on healthy lists. Consume the boolean directly; retain real mutation/pin/pagination failures. Do not suppress all errors or introduce a second failure owner in the renderer.
- Verification: evaluate the actual frontend projection expression with healthy, pagination-failure, mutation-failure, pin-failure and pending-without-error inputs; healthy/pending project false and actual failures project true. The exported Expo Web fixture confirms the hint is absent on healthy state, present on failure and absent after recovery, preserving runtime ID and Chat draft with no page exceptions.
- Existing pagination tests pass (6); frontend typecheck baseline passes (166 current, 171 baseline, zero new). Rebuilt `build:agents-next`, packaged DOM smoke and iOS JS bundle pass; lightweight preview manifest/origin passes without a bundle download. The local HTML asset is regenerated, so Expo Go must reload to consume this fix. No live backend failure was inferred from the screenshot.

## Panel chrome and native swipe (2026-10-09)

- User requested smaller top icons matching OpenCraft's actual left/right sidebar glyphs, then authorized left-swipe opening of the right pane. Router query `OpenCraft Expo Shell sidebar toolbar icon selection geometry` matched no Pack; bounded source inspection reached desktop chrome-actions, shared Expo controls and the existing native drawer pan. Existing Shell/bridge/Expo guidance applies.
- Move desktop path geometry into a design-system subpath; desktop keeps identical paths and rendering behavior. Expo uses native SVG at the same 16-point optical size, right rotated 180 degrees, neutral color and 44-point HeroUI Native touch targets. The left large accent background is removed. Both toggles project actual open state.
- One native pan selects navigation or right-pane intent once per contact. Closing left navigation cannot also open the right. Available right-pane release commands carry the captured owner ID and recheck current availability/owner in the host. Wide layouts keep docked navigation while permitting panel gestures. No second panel store or viewer rewrite.
- Passive DOM touch ownership reports controls/editables/horizontal scrollers through a boolean, runtime-validated message. Native pan yields; vertical threshold and native scrolling relation remain. Release/cancel/reload clear DOM ownership. Right-pane action commits on deliberate release, not a new continuous panel animation. Device gesture feel remains unverified.
- Patch checkpoint: exact-text patch anchors differed in JSX/document line wrapping; re-read bounded source and applied verified anchors. No design change inferred from those edit failures.

- Browser fixture checkpoint: load waiting timed out on unrelated document resources; use DOMContentLoaded plus explicit console/frame readiness. Selection testing initially retained the focused draft input’s collapsed range, so addRange did not select fixture text. Clear the existing range and assert a non-collapsed real selection before checking touch ownership; no application selection behavior was changed to satisfy the fixture.
- Actual exported Expo Web passes neutral 16-point glyphs with 44-point targets, open-state projection, right glyph rotation, control/horizontal-scroll/selection ownership and end/cancel release at widths 390/520/1024/1200. Runtime identity and Chat draft remain intact with zero page exceptions. Native pan keeps its chosen target during a reversed stroke; deliberate release still goes through the current original panel owner. This fixture uses synthetic resources and does not establish iPhone gesture timing or live transport.
- Final verification: 11 focused swipe/layout tests and 12 bridge/presentation tests pass; boundaries, typography, design-system/Web/Expo types and frontend baseline pass (zero new errors). Full packaged runtime build/smoke, Expo Web export and final iOS bundle (4,797 modules) pass. Exported browser acceptance and whitespace/formal change-impact pass. The catalog is regenerated; its global validator still exits 1 for the previously recorded sparse-checkout/repository-wide findings. All four Metro/Next/tunnel services are active, Web route responds HTTP 200, and lightweight external iOS manifest/origin passes without downloading the bundle. No commit, push or production operation.

## Native audio / packaged resource boundary (2026-10-09)
- User: investigate website microphone prompt, prohibit remote JS/CSS, compare Paseo cross-platform ownership.
- Router query `opencraft Expo embedded microphone native recording remote JS CSS runtime` matched no Pack. Bounded search found CloudSpeechInputProvider using default BrowserAudioCapture in embedded-chat-application.
- Read maintenance skill/verification, mobile bridge, Expo/Root/Frontend AGENTS; adjacency frontend runtime card checked generated mobile HTML and its smoke neighbor.
- Read-only reference `/data/mono2/ref/paseo` at `3cc4ae2`: shared dictation contract, native/Web audio source and native audio engine. Adopts platform ports, not bespoke module or Unistyles.
- Official Expo Audio documentation was fetched read-only after web search tool failed (provider route 404); local SDK native module manifest selects expo-audio ~57.0.4.
- iOS native capture feeds existing ASR/provider/Composer via generation/request-scoped bounded frames; Web capture unchanged. CSP now blocks remote styles/fonts and nested documents as well as executable scripts/workers.
- Native permissions, interruptions and real audio quality not yet hardware verified. Prior icon/left-swipe work remains included in the ongoing dirty worktree; no commit/push authorized.

## Sibling pane topology and interactive motion (2026-10-09)

- User observed missing left-swipe animation and clarified that landscape/pad should be genuine split panes, not merely a right pane superimposed by stacking. Router `OpenCraft Expo right panel swipe interactive animation` matched no Pack. Bounded searches followed Expo geometry/gesture → mobile bridge → local custom element → original AppShell/RightPanel; read maintenance skill/checklist, Shell/bridge design and frontend design guidance.
- Source cause: the external panel was an absolute sibling positioned over a width-adjusted Chat mount, while Chat's original `position:fixed` AppShell still used the full custom-element containing block. Previous browser fixture imitated that allocation instead of consuming the actual embedding adapter, so its toolbar bounds did not prove Chat capacity.
- Ownership: original WorkbenchPanelService owns open intent, tabs and resources; an embedded parent grid owns sibling Chat/right-pane viewport geometry and one transient animation/contact; native pan owns only admission and input samples. Keep one DOM runtime/React context. No second WebView/application or copied pane contents. Expo measures the outer available space and sends geometry; the old decorative native boundary is removed. The pane internals remain DOM; this does not claim two independent native DOM views.
- Acceptance includes intermediate held progress, insufficient release/cancel, animation reversal, old owner/contact rejection, resize during held contact, reduced motion and wide split vs narrow replacement. Chat's measured AppShell/frame and right-side controls must fit their own column; draft/runtime/resource state must survive. Native bridge timing and iPad hardware remain separate evidence.

- Resource audit also found always-mounted remote account WebView in mobile-home-route. Removed it and obsolete token injection/static prefetch helpers; account/realname/billing open system browser, with native account and Bot continuity retained. Retired account-web/billing Shell destinations and associated stale tests.
- The shared bridge now also contains concurrently introduced chat-panel-gesture capability; preserved it and brought the old capability expectation in its protocol test up to date.

### Native audio validation checkpoint
- Expo and Workbench Web typechecks pass; frontend baseline remains 166 current/171 baseline, zero new diagnostics.
- 15 focused audio/bridge/external-route tests pass; native device fixture covers pending permission cancellation, replacement-runtime exclusion, normal delivery and temporary file deletion. The additional Shell return model test passes.
- Packaged Bot build and DOM smoke pass; actual Chromium enforcement of the generated CSP blocks network script/style/frame loads and preserves inline styling and API fetch.
- Expo Web export passes; iOS bundle includes expo-audio (4808 modules). Final cleanup-only bundle rebuild and lightweight preview verification follow.
- No real microphone, live ASR, browser account session or iPad hardware acceptance was performed; these remain separate from fixtures/build results.

### Native audio handoff
- Final Expo typecheck, audio tests, Shell return test, iOS bundle, Workbench Web typecheck, frontend typecheck baseline, resource CSP browser probe and packaged DOM smoke passed. Dependency licenses regenerated.
- Temporary-index change-impact check passed; real Git index untouched and frontend/next-env.d.ts excluded. Global context catalog regeneration still reports existing sparse-checkout missing paths; it is not a clean global gate.
- Expo preview Metro restarted for the new installed SDK dependency; external iOS manifest and bundle-origin check passed without downloading a bundle. Desktop Web tunnel required reconnection; only its local preview tunnel is restarted.
- Reference files are read-only. No commit, push, production operation, real microphone capture or paid transcription performed.

- Web tunnel recovered at https://projectors-constant-speech-commons.trycloudflare.com/agents-next/; Expo Go remains exps://probably-has-identical-grades.trycloudflare.com. URLs are temporary preview handoff, not product configuration.

- Implementation: replace absolute right-pane positioning with an actual shared grid parent and contain Chat's AppShell in its assigned column. `EmbeddedHostPanelLayout` owns transient progress/contact, not panel intent; original service admission commits release. Native input is sampled/coalesced to the same local DOM driver. Owner-scoped presentation activity retains exit content and supports reversal; the native gesture reads that projection through a shared value, avoiding gesture reconstruction when the presentation becomes active.
- Browser acceptance uses the actual layout adapter/styles plus original AppShell, RightPanel and WorkbenchPanelService. It passes held 0.3→0.7→0.25, cancellation, interrupted button spring, reversed close, width replacement/late terminal rejection, original resource-input retention and reduced motion at 390/520/760/1024/1200/1366. Actual Chat Shell/frame and a right-edge input/action capacity probe fit the column; wide panes share a boundary and Chat stays interactive, narrow Chat is inert only during replacement. No page exceptions. Resource viewers and remote state remain synthetic; this does not prove live backend or real Composer/keyboard hardware interaction.
- Motion lifetime review: capture the clamped displayed position after stopping a spring, and keep presentation activity until the spring finishes even when its raw value crosses the endpoint. This prevents spring overshoot from briefly retiring/restarting panel contents. Old owner/contact samples and disposal are also rejected in the real adapter probe.

- Final checks: 15 focused panel/protocol/root tests and 10 swipe/layout tests pass; panel/Web/Expo types, boundary checks and frontend baseline pass (166 current / 171 baseline, zero new). Final packaged HTML/Expo Web build, DOM runtime smoke and iOS JS bundle (4,808 modules) pass. Browser adapter/component acceptance and whitespace/temporary-index change-impact pass. Catalog regeneration still returns the pre-existing global sparse-checkout/repository findings; no new gate or unrelated repair.
- Preview receipt: Metro and Next run this integration checkout. Expo lightweight external iOS manifest/origin passes without downloading the bundle. The previous Web Quick Tunnel URL returns 530 because the active tunnel has changed; read the current registered URL and confirm `/agents-next/` HTTP 200. Updated Web URL: https://projectors-constant-speech-commons.trycloudflare.com/agents-next/ . Expo URL unchanged. No Git delivery or production changes. Native hardware feel, bridge latency and iPad keyboard behavior remain unverified.

## Create form → same Bot conversation return (2026-10-09)

- User reproduction: open Create Bot, then select a conversation without switching Bot; creation remains visible. Semantic target: return to the requested conversation on the existing Bot/controller, preserving its draft and avoiding a fabricated Bot switch.
- Router query `frontend mobile-dom create bot session selection opencraft Expo navigation`; read `docs/context/domains/identity-access.md`, `docs/context/project/services/frontend.md`, frontend/Expo/OpenCraft AGENTS, frontend DESIGN, maintenance skill/checklist and mobile bridge design. Identity pack is not an auth change: this task concerns conversation selection.
- Root cause: the full-page creation branch unmounted AgentConsoleHostProjection and AgentChatMigrationSurface. Native/Web sidebar still had the last session projection; same-Bot session intents then had no active controller listener. The create bridge also changed section to Channel unnecessarily.
- Creation now retains the selected section. Embedded creation keeps the current Bot/controller and projection mounted with its canvas hidden and inert; Chat presentation is inactive until returning. Existing session handlers navigate away from the creation query and reveal that same controller. Website full-page creation layout, current readiness/pending checks, Bot ownership and mutation authority remain unchanged.
- Actual Chromium packaged-frontend acceptance at widths 390/1024 passes Create → existing session, Create → new session, and Create → same Bot. It also rejects a stale Bot command, verifies the target selection, exactly one session creation, one Chat mount/no disposal, retained draft and zero page exceptions. Transport and Chat custom-element APIs are explicit fixtures; this does not establish live backend or iPhone interaction.
- Portable regression `opencraft/apps/workbench-expo/scripts/smoke-mobile-bot-create-return.mjs`; generated HTML/Expo Web export and existing DOM smoke pass. Frontend baseline: 166 current/171 baseline, zero new diagnostics. Browser module parsing exceeded the initial 10-second navigation timeout once; use a 30-second navigation bound, preserving condition-based interaction assertions. No application timing workaround.
- Initial file searches used an incorrect script/context filename; narrowed to the existing Expo scripts and agent/repository contexts. No source change was inferred from missing filenames. A retained grid needs its explicit hidden selector because packaged CSS forces grid display with !important; actual browser visibility is included in acceptance.
- Final checks: iOS bundle passes (4,810 modules/24 assets), whitespace and focused formal change-impact pass. All four preview services remain active. External iOS manifest/origin passes without downloading the bundle. Local packaged asset changed; Expo Go requires Reload. No commit/push or production changes.

## Bot navigation continuity (2026-10-09)

- User sequence: switch A → first visit B → switch Daily/Explore → return A → rapid A/B while projections arrive. Semantic target: navigation stays present; only the selected Bot's sessions/actions are active.
- Router `OpenCraft Expo switching Bot navigation Daily Explore flicker` matched frontend-product-surface; context receipt: frontend service detail, root/OpenCraft/Expo/Frontend AGENTS, frontend design, mobile data architecture and frontend runtime adjacency. Checked adjacent projection generation in agent-settings-page and packaged export generator.
- Source cause: iOS explicitly clears consoleState on selection, Web filters the old projection to null; shared groups iterate an empty array until the frontend post-commit projection arrives. Tabs stay mounted, but their feature children disappear.
- Shared native/Web display model keeps bounded runtime-local per-Bot snapshots and stable feature identities. Cold target preserves noninteractive feature geometry and anonymous session placeholders; warm target displays only its own sessions. Readiness is separate: target receipt enables navigation, while the original controller retains command authority. Empty loading reads preserve own rows; successful empty results remove them. Catalog deletion, runtime/account/locale replacement and LRU bound the lifetime. No new Bot runtime, hidden paid requests, persistent cache or business controller.
- Verification pending: model boundaries, both host types, exported browser cold/warm/rapid switching with delayed projections and unchanged DOM/runtime identity, final iOS bundle and lightweight preview receipt.

- Final navigation receipt: Expo types, 5 continuity + 4 swipe model tests, packaged runtime/Expo Web export and iOS bundle (4,810 modules) passed. Exported browser fixture passes cold/warm/rapid switching at 390 and 1200 widths, preserving feature DOM nodes, Tabs choice and draft/runtime; old projections cannot activate target actions. Deliberate Tabs changes are excluded from the feature-node observer because library Content may retire the inactive category. Session placeholder uses its original component's layout metrics. This is a synthetic bridge fixture, not iPhone hardware or live backend evidence.
- User then requested full Expo HeroUI audit and clarified design constraints rather than a new visual style. This proceeds in 2026-10-09-expo-ui-audit; no unrelated visual rewrite is included in the navigation fix.

## Chat scroll and Shell swipe admission (2026-10-09)

- User observed intermittent vertical Chat scroll loss near left/right pane switching. Reproduction target: diagonal vertical scroll stays in Chat; lifting and starting a clear horizontal stroke can open a pane immediately.
- Router query `OpenCraft Expo Chat vertical scroll native sidebar horizontal gesture arbitration` matched no Pack. Bounded source search covered native drawer, swipe model, WebView gesture wrapper, packaged touch bootstrap, and original Chat scroller. Read the existing mobile Shell/bridge design and OpenCraft maintenance verification guidance.
- The native pan previously activated at horizontal 18 points while vertical motion remained under 16. A diagonal x20/y15 touch could therefore activate before `onStart` chose a pane, allowing UIKit to cancel WKWebView scrolling. This is a source-supported likely cause; it has not been observed on hardware here.
- The drawer now uses Gesture Handler 2.x manual admission before activation. Vertical or ambiguous diagonal motion yields for the rest of the contact; only clearly horizontal motion activates one available pane. Controls, multiple contacts, unavailable destinations and undecided taps do not activate a no-op pan. New contacts are admitted afresh. The WebView gesture remains simultaneous and Chat's original scroll implementation is unchanged.
- Verified with 12 model/actual Drawer callback tests: diagonal and vertical drift, immediate fresh horizontal contact, control ownership, unavailable/docked destinations, tap, extra finger, cancellation retaining panel identity, reversal and opposite-pane next contact. Native gesture and animation ports are fixtures, so UIKit/WKWebView recognition is still a device check. Expo typecheck and iOS JS bundle (4,810 modules/24 assets) pass; formal change-impact and lightweight iOS manifest/origin pass without downloading the bundle.
- The official documentation tool returned a provider route 404 and direct docs fetch returned 403; the installed Gesture Handler 2.x TypeScript and iOS recognizer source supplied the API/behavior evidence. An initial fixture file command used an extra `opencraft/` path and created no file; it was reapplied at the correct path. The `.mjs` model test uses Node 22 type stripping because this workspace's `tsx` loader treated the Expo `.ts` file as CommonJS. No package type or application timing behavior was changed.

### iPad gesture end-state follow-up (2026-10-09)

- User reported the tablet client exits while sliding a sidebar. Metro and Cloudflare preview processes remained active; no device crash report is available, so the exact native cause is not confirmed.
- Review found a concrete right-panel lifecycle fault: `onEnd` erased the panel target before `onFinalize`, while a late `TOUCHES_UP` could still call `manager.fail()` on the completed recognizer. Cancellation also had no success distinction. The target now persists until finalization; only a still-pending tap may fail on touch-up, and a cancelled active pan emits `cancel` once.
- A wide-layout callback fixture covers both touch-up/END orderings and the extra-finger cancel path. All 13 focused model/callback tests pass. Expo typecheck, iOS production JS bundle and lightweight Expo manifest/origin check pass. A real iPad reproduction is still needed before claiming the exit is eliminated.
- User retried in iPad Expo Go and still reported immediate exit on swipe. Until the exact touch region/system crash trace arrives, iPad Shell presentation now omits the full-scene Pan detector in full screen, compact iPad mini and split layouts; iPhone compact presentation retains direction admission. Native sidebar scroll and pane toggle buttons remain mounted. A JSX fixture asserts iPad wide/split vs iPhone detector topology. This is a diagnostic mitigation: iPad left/right pane swipe is temporarily unavailable. Expo typecheck and six Drawer fixture tests pass; actual iPad result remains unverified.
- Device follow-up: user reloaded the diagnostic build in iPad Expo Go and confirmed swiping no longer exits. This isolates the crash to the full-scene pan path but does not distinguish Gesture Handler/WKWebView interaction from one of that pan's callbacks. Keep the iPad pan detached until a smaller gesture surface or native trace is verified on device; do not claim the original swipe functionality is restored.
- User clarified the original trigger was a leftward swipe on the left sidebar. Added a separate iPad-only Pan detector on that native sidebar view to close navigation; it does not wrap Chat/WKWebView or dispatch right-panel gestures. Horizontal activation and vertical failure thresholds protect the sidebar list scroll. Wide layout hides the docked sidebar; compact layout settles drawer progress closed. The full-scene iPad Pan remains absent. The actual Drawer callback/topology fixture covers wide/split close, short/cancelled strokes and preserved Chat tree. This local replacement remains device-unverified; user should test the exact sidebar left swipe in Expo Go.
- User observed that the new close switched layout instantly. The iPad sidebar-local Pan now drives a single shared progress for both sidebar translation and main scene's left edge, following the finger and springing on release. The toolbar button uses that same spring and a target value so an immediate second tap reverses it. Compact iPad drawer uses the existing progress. The WebView stays mounted during width changes. Callback/geometry tests cover drag midpoint, close, cancel/short restore, split close and rapid button reversal; device visual smoothness and crash behavior still need iPad observation.
