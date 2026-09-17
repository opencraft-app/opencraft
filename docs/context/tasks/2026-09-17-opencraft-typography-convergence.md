---
id: opencraft-typography-convergence
type: task
scope: Converge OpenCraft font stacks, semantic typography roles, text tones, and platform rendering policy into one auditable design-system topology.
triggers: ["typography", "font stack", "semantic text style", "Codex font solidity"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/design-system/src/typography/
  - opencraft/packages/design-system/src/typography.web.scss
  - opencraft/AGENTS.md
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Replace conflicting Web/Native/component typography declarations with one semantic registry and platform adapters, then migrate the OpenCraft Shell typography that currently looks lighter than Codex.

## non_goals

- Do not globally increase font weight or restyle Agent Console/marketing content.
- Do not couple text color into low-level font metric definitions.
- Do not force identical physical glyphs across Web, Electron and Native.
- Do not edit generated upstream snapshots, publish, or release.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-17: deeply compare OpenCraft, BB and Codex, converge to semantic typography tokens plus a unified font stack, update AGENTS.md constraints, and keep the file topology clean.

## interface_refs / data_structure_refs

- `typography.tokens.json`: canonical platform role registry.
- `typography.shared.ts`: typed TypeScript projection consumed by Native/shared code.
- `_generated.web.scss`: generated Web variables and allowed-role inventory.
- `typography.web.scss`: hand-written role/tone composition primitive and rendering policy.
- Invariant: family/metrics, text tone, and rasterization policy are orthogonal owners.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/packages/design-system/src/tokens.shared.ts`, `opencraft/packages/design-system/src/tokens.web.scss`.
- `relevant_evolution`: recovered Codex uses system UI and primary text for important navigation; BB uses Inter but full sidebar ink. OpenCraft currently mixes Inter-first Web CSS, system-family shared tokens, multiple Sidebar sizes, secondary foreground and global grayscale antialiasing.
- `superseded_refs`: feature-local Sidebar/Work font declarations replaced by semantic roles.

## acceptance

- One canonical registry drives shared/Native typography and generated Web role variables.
- Shell navigation, Work navigation and Thread titles consume semantic roles with primary tone; metadata remains secondary/tertiary.
- macOS Electron computed styles use the unified system-first stack, 14/20/400 navigation metrics, primary foreground and default font smoothing.
- AGENTS.md forbids new feature-local font metrics, fractional weights, tone/metric coupling, and generated-file edits.
- Focused typography/theme/Shell tests, boundaries, typechecks, Web/Electron builds and isolated Electron visual checks pass.

## affected_paths

- `opencraft/packages/design-system/src/typography/`
- `opencraft/packages/design-system/src/typography.web.scss`
- `opencraft/packages/design-system/src/tokens.shared.ts`
- `opencraft/packages/design-system/src/tokens.native.ts`
- `opencraft/packages/design-system/src/tokens.web.scss`
- `opencraft/packages/design-system/src/controls.web.scss`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/AGENTS.md`
- `opencraft/docs/platform-architecture.md`
- `opencraft/tests/`

## required_context

- Context route `OpenCraft typography semantic text style font stack platform rendering policy AGENTS topology` returned no Pack; bounded exact search was used.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Repository mutation and validation rules. | Preserve dirty worktree and delivery boundary. |
| `opencraft/AGENTS.md@worktree` | OpenCraft ownership and preview rules. | Add durable typography constraints at the correct local entry. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Required maintenance method. | Model ownership before visual edits. |
| `opencraft/.agents/skills/baseline-ui/SKILL.md@worktree` | Typography/UI baseline. | Avoid arbitrary tracking, fractional weights and feature-local scale drift. |
| `opencraft/docs/platform-architecture.md@worktree` | Package topology authority. | Document the registry/adapters/consumer direction. |
| `ref/codex/lazy/app-initial/assets/app-initial-register-styles.css@worktree` | Requested Codex reference. | Verify system stack, 14/20/400 and primary text hierarchy. |
| `ref/bb/apps/app/src/components/ui/theme.css@worktree` | Requested BB reference. | Verify Inter can remain solid when Sidebar uses full ink and default smoothing. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@worktree` | Required adjacency review. | Confirm no frontend i18n/generated snapshot work is required. |

## evidence

- TDD red/green: the new public typography export initially failed resolution; the finished suite verifies one Web/Native role inventory, generated Web output, semantic Shell consumers, canonical weights, smoothing policy, and AGENTS topology.
- `npm run check:typography` passes and is part of `check:boundaries`; stale generated SCSS now fails the repository gate.
- Design System, Web and Expo typechecks pass. Focused typography, theme, Shell and Work navigation suites: 33 passing. Workbench unit suite: 244 passing.
- All `npm run gate` stages passed across the initial run plus the resumed post-fix stages: workspace typechecks, extensions, AppServer, projects, Thread lifecycle, native speech, DSH bridge, AppServer lab, Chat, Workbench, Shell, environments, desktop login, Web release, Web build, Expo Web export and Expo iOS bundle.
- `npm run build:electron` passes. Isolated Electron profile `/tmp/opencraft-typography-preview` on CDP 9343 reported, in both light and dark themes: Start/Skills = system-first 14/20/400 primary, Work = 13/18/600 primary, smoothing `auto`, 34px action rows, no alert and no renderer exception.
- Visual evidence `/tmp/opencraft-typography-light.png` confirms denser primary Sidebar text without globally increasing regular weight or shifting the Skills page geometry.
- Documentation validation, explicit change-impact validation and `git diff --check` pass.

## risks

- A global family/smoothing change can affect content surfaces; migration and live verification must distinguish Shell from long-form content.
- Generated Web output can drift unless a deterministic check is part of the repository gate.
- Existing feature-local CSS may intentionally represent content typography and must not be mechanically rewritten.

## validation

- Red/green registry-generation and role-consumer tests.
- Design-system and Web typechecks, platform boundaries, affected Shell/theme suites.
- Web and Electron builds, then isolated Electron computed-style and screenshot inspection.

## decisions

- Use a checked-in JSON registry as data authority because TypeScript and the Node generator can consume it without a second metric definition.
- Generate only variables/role inventory; keep the Sass role/tone primitive hand-written and small.
- Text tone and platform smoothing are not fields of low-level TypographyRole.

## scan_scope

- `opencraft/packages/design-system`
- `opencraft/apps/workbench-web/src/styles` and Shell components
- related theme/Sidebar tests
- `ref/codex` and `ref/bb` typography/Sidebar references.

## scan_output

- Direct bounded source trace; Graphify remains prohibited and was not used.

## handoff

- Complete in the current dirty worktree. The isolated Electron preview remains running on CDP 9343 for inspection.
- Source delivery is limited to the dedicated typography commit on the current branch; no MR, release, production, cloud, account or credential mutation is part of this task.
