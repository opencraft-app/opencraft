---
id: chat-demo-management-navigation
type: task
scope: Migrate the Skills and Cloud Storage workbench navigation from codex/chat-demo-v2 into the current OpenCraft Web implementation.
triggers: ["chat demo navigation", "Skills", "Cloud Storage", "OpenCraft workbench"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/apps/workbench-web/src/app.tsx
  - opencraft/apps/workbench-web/src/components/hostless-workbench.tsx
  - opencraft/plugins/lightvela-hermes/src/extension.ts
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-15
revision: 1.7.0
precedence: task
derived: false
---

## goal

Expose the complete `chat-demo-v2` Skills workspace and Cloud Storage through existing Workbench navigation surfaces while preserving Host, Profile, and conversation ownership. Skills browsing stays anonymous; install and uninstall explicitly target either local DSH user Skills or one connected Hermes Profile.

## non_goals

- Do not introduce a new Cloud Storage API or file backend.
- Do not change Hermes control-plane authentication, conversation Bot selection, or runtime execution routing.
- Do not alter GitOps, deployment, or external cloud resources.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-16: inspect `codex/chat-demo-v2` and migrate its Skills and Cloud Storage page entry.
- User request, 2026-09-17: choose installation between local DSH and a specific Hermes Profile; local DSH persists under `~/.opencraft/skills` and reads both OpenCraft and `.agents` roots.

## interface_refs / data_structure_refs

- Settings pages are extension contributions selected through `WorkbenchNavigation`.
- `lightvela.hermes.skills` mounts the full discovery, Experts, learning/import and installed-state workspace. The selected installation target owns installed-state mutations; cloud runtime operations remain separately bound to the selected instance.
- Profile Skills scope is a discriminated union: native Hermes Profile or local DSH user root. Local DSH accepts an explicit bounded artifact and never interprets itself as a Hermes Profile.
- Local DSH discovery retains native `<cwd>/.agents/skills` and `~/.agents/skills`, and additionally reads `<cwd>/.opencraft/skills` and `~/.opencraft/skills`. The workspace root is resolved from each lookup cwd, never the host process cwd.
- `lightvela.hermes.storage` retains its existing cloud Bot/instance requirement.
- Workbench route changes must not recreate or mutate a conversation, Host, or selected Bot.
- Standalone management routes replace only AppShell content. Shared window chrome, native drag regions, navigation controls and sidebar resize ownership remain mounted for every route.
- `New chat` means navigate to Home with a local Draft. It must leave Skills synchronously and cannot wait for a physical Host connection or create a remote Thread before first submit.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/design/README.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: `origin/codex/chat-demo-v2@98d772d06` introduced a Work navigation presentation around existing Hermes management pages.
- `superseded_refs`: the source branch's older AppShell implementation is reference-only; its behavior is adapted to the current shell.

## acceptance

- An active LightVela Hermes contribution exposes Skills and Cloud Storage in the Workbench navigation.
- Selecting either route keeps the Workbench shell and renders the contributed view without inserting a new sidebar subgroup.
- Skills renders the full `HermesAgentSkillsPanel`, not a reduced installed-skills switch list.
- DSH sees both user and workspace OpenCraft skill roots while preserving its native `.agents` discovery roots.
- A compact accessible selector lists local DSH and available Hermes Profiles without calling either target a Bot.
- Local SkillHub installation writes atomically below `~/.opencraft/skills`; uninstall moves the exact managed entry into recoverable `.trash` storage.
- The conventional management modal remains for non-migrated management pages.
- Skills and Cloud Storage retain the same draggable titlebar and sidebar resize ownership as conversation routes.
- Skills follows the compact Agent Console hierarchy: the standalone route suppresses both the outer `Skills` page header and the optional panel `技能` heading/description block, so the marketplace tabs begin the content surface. Installation authority remains a compact selector beside those tabs without exposing its filesystem path.
- Skills declares the Shell-owned `edge-to-edge` settings layout; the marketplace tabs and installation selector share one compact row after the persistent toolbar instead of stacking Settings document padding and a separate selector row.
- Skills registers that compact toolbar into the persistent AppShell Header region; search and catalog remain Content. Registration is route-scoped and preserves the feature's React context through the Web portal adapter.
- Clicking New chat from Skills immediately presents the Home Composer and Draft URL even while Host readiness is pending or failed.
- Focused UI tests and the affected OpenCraft type/lint gates pass.

## affected_paths

- `opencraft/apps/workbench-web/src/`
- `opencraft/apps/local-agent-host/src/`
- `opencraft/packages/appserver-protocol/src/`
- `opencraft/packages/profile-skills-appserver/src/`
- `opencraft/plugins/lightvela-hermes/src/`
- `opencraft/tests/`
- `opencraft/design/invariants.md`

## required_context

- `frontend-product-surface`: `docs/context/project/services/frontend.md`.
- OpenCraft shell and presentation: `opencraft/AGENTS.md`, `opencraft/docs/platform-architecture.md`, `opencraft/design/README.md`.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Repository change boundaries. | Preserve dirty worktree and delivery constraints. |
| `opencraft/AGENTS.md@worktree` | OpenCraft ownership and preview requirements. | Scope migration to Web presentation. |
| `docs/context/project/services/frontend.md@worktree` | Router-required product surface context. | Keep UI verification explicit. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | OpenCraft maintenance rules. | Preserve route and shell ownership. |
| `opencraft/docs/platform-architecture.md@worktree` | Runtime and extension ownership. | Avoid protocol or Host changes. |
| `docs/engineering/domains/agent-gateway-runtime.md@worktree` | Change-impact mapped formal design. | Record persistent AppShell chrome as a domain invariant. |
| `docs/context/project/services/ctl.md@worktree` | Router-required weak adapter match. | Confirm CTL is not an authority for local DSH Skills. |
| `opencraft/design/README.md@worktree` | Workbench presentation contract. | Update invariants for a changed shell route. |
| `origin/codex/chat-demo-v2@98d772d06` | Requested reference implementation. | Port only compatible user-visible behavior. |

## evidence

- User correction identified the installed-only Skills list as the wrong product model. The wrapper now matches `origin/codex/chat-demo-v2`: `HermesAgentSkillsPanel` receives the Profile Skills data layer, selected Bot runtime command port and repository context.
- Focused navigation/Profile Skills tests 8/8, Web/Hermes typecheck, `test:extensions`, platform boundaries and Electron build pass.
- Electron build emits the dedicated `agent-skills-panel` lazy chunk; source-contract tests assert Discover/Experts/learning surfaces rather than an installed-only switch list.
- Anonymous Cloud Storage runtime preview reaches the standalone management page and complete login controls. Authenticated populated Skills interaction remains a separate live-account gate.
- Source-contract regression coverage now rejects route-dependent `header=null`; both Workbench boot paths always provide the shared `AppShellHeader`, and the AppShell header type is structurally non-nullable.
- A current-tree Electron build launched with an isolated profile on 2026-09-17. On the real Skills route, native titlebar dragging remained active and a held sidebar resize changed the live separator from 240px to 341.25px. Cloud Storage retained the same Shell chrome and native drag behavior after route navigation.
- An intermediate isolated Electron preview on 2026-09-17 removed the outer `Skills` title and the `安装位置`/`~/.opencraft/skills` block, but still exposed the panel-owned `技能` heading; the user rejected that remaining header before the final correction below.
- After the user's second correction, the refreshed current-tree Electron preview at its own loopback origin shows the marketplace tabs as the first content row: neither `Skills` nor the optional `技能` heading/description block is present, while the compact target selector remains available. This required a Renderer rebuild and window restart, not a release package.
- The current-tree isolated Electron preview verifies route-first Home navigation from both Skills and Cloud Storage: one New chat click immediately changes the URL to the local Draft root and displays the Home Composer while the execution control still reports `Waiting for execution host`. This proves physical Host readiness no longer owns application-route exit.
- Electron geometry sampling at 1440px verifies the compact catalog layout: the fixed AppShell header ends at 46px, both tabs and the target selector start at 62px, and the previous 76px post-toolbar blank region is reduced to one 16px panel inset.
- Final Header-region Electron validation places tabs and the target selector inside the 46px persistent titlebar, with the search field beginning at 62px. The toolbar spans the full content width and the selector right edge reaches 1428px in a 1440px window. Navigating Skills→Cloud Storage removes the registered toolbar immediately. An intermediate ReactNode re-render lost Radix Tabs context and was rejected; the final portal-backed region preserves it and eliminates the recovery error.
- Local DSH smoke starts the real engine and capability bridge, and the DSH bridge suite passes; the discovery provider preserves native `.agents` roots while adding dynamic workspace and persistent OpenCraft roots.
- Local DSH Profile Skills tests exercise bounded atomic install, idempotency, traversal rejection, installed listing, content reads, recoverable uninstall and the real AppServer WebSocket route against an isolated root.
- The local DSH data-layer test resolves a synthetic public SkillHub file list/content response into the bounded AppServer artifact. `test:dsh-bridge`, `test:extensions`, focused UI tests, affected typechecks, platform boundaries and the LightVela Web build pass.
- The refreshed `127.0.0.1:10002` preview shows the compact installation-location row above the anonymous SkillHub catalog, with no login wall and no browser console errors. Web correctly reports no install target because it has neither Electron's local Host nor an authenticated Hermes connection.

## risks

- The source branch predates the current AppShell and overlaps user changes. Port behavior selectively rather than applying its patch.
- Management routes can hide the conversation surface; route selection must remain navigation-only.
- Route-specific chrome removal would recreate the undraggable blank titlebar observed on macOS; the type boundary prevents that invalid shell state from returning.

## validation

- Run affected OpenCraft UI tests, DSH bridge tests, local-agent smoke, and type/lint commands identified from `opencraft/package.json`.
- Verify the Web route with an isolated local preview. Local DSH target visibility requires the Electron-owned local Host; authenticated Hermes mutation remains a separate live-account gate.

## decisions

- Reuse existing contributed views, preserving their current authority and error handling.
- Keep the public SkillHub catalog independent from target authority. The chosen Host owns only installed-state reads and mutations.
- Preserve Hermes Profile identity explicitly on the Bot directory projection solely to route Profile-owned Skills; user-facing copy says Profile, not Bot.
- Keep `runtime` and `diagnostics` in the existing management dialog; migrate only the requested Work surfaces.
- Follow the Codex shell/route-region split: the AppShell owns physical chrome for its whole lifetime, while Skills and Storage contribute content only. WB's route-local drag regions confirm the same invariant but are not copied into each OpenCraft page.
- Preserve the older OpenCraft Agent Console heading ownership from `wip/opencraft-current-20260914` and `codex/opencraft-desktop-runtime`; do not inherit the duplicate unconditional `SettingsPageHeader` introduced by the later chat-demo snapshot.
- The shared mono2 panel keeps its heading enabled by default; OpenCraft disables it through an explicit prop. The sync adapter must preserve that prop while injecting the OpenCraft `skillsDataLayer`, so generated sources remain reproducible.
- Follow Codex's unified `navigateToHome` ownership and WB's route-first ordering: local Home/Draft presentation commits before Host/Workspace preparation. Do not repair this with a page-local `closeSettings()` race.
- Follow Codex `PageLayout` ownership for catalog geometry: layout intent is contribution metadata interpreted by Settings Shell, while the Skills feature owns only its internal toolbar and content. Do not use negative margins or renderer-width conditionals in the feature.
- Mirror Codex `AppShellComponents.Header` semantically: route children register, Shell renders, scope cleanup retires. Platform implementation may use a portal when required to preserve renderer context, but extensions never query or position the physical Header DOM.

## scan_scope

- `opencraft/apps/workbench-web/src`, `opencraft/plugins/lightvela-hermes/src`, `opencraft/tests`.

## scan_output

- Bounded source and reference-branch comparison only.

## handoff

- Complete in the current worktree. No commit, push, merge, preview publication, or external mutation has been performed for this revision.
- Packaged Electron display of the live local-target option and authenticated Hermes Profile mutation remain platform/account acceptance checks; protocol routing and isolated local writes are verified independently.
