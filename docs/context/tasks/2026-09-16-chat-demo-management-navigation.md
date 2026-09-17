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
reviewed_at: 2026-09-16
review_due: 2026-12-15
revision: 1.0.0
precedence: task
derived: false
---

## goal

Expose Skills and Cloud Storage through existing Workbench navigation surfaces while preserving Host, Bot, and conversation ownership. Skills must use the connected Hermes Host's native Profile Skills protocol without a LightVela login dependency.

## non_goals

- Do not introduce a new Cloud Storage API, file backend, or Skills protocol.
- Do not change Hermes control-plane authentication, Bot selection, or AppServer contracts.
- Do not alter GitOps, deployment, or external cloud resources.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-16: inspect `codex/chat-demo-v2` and migrate its Skills and Cloud Storage page entry.

## interface_refs / data_structure_refs

- Settings pages are extension contributions selected through `WorkbenchNavigation`.
- `lightvela.hermes.skills` reads and updates the connected Host's `default` Profile through the existing Profile Skills protocol.
- `lightvela.hermes.storage` retains its existing cloud Bot/instance requirement.
- Workbench route changes must not recreate or mutate a conversation, Host, or selected Bot.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/design/README.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: `origin/codex/chat-demo-v2@98d772d06` introduced a Work navigation presentation around existing Hermes management pages.
- `superseded_refs`: the source branch's older AppShell implementation is reference-only; its behavior is adapted to the current shell.

## acceptance

- An active LightVela Hermes contribution exposes Skills and Cloud Storage in the Workbench navigation.
- Selecting either route keeps the Workbench shell and renders the contributed view without inserting a new sidebar subgroup.
- Skills can load and enable/disable a connected Host's Profile Skills without a LightVela account session.
- The conventional management modal remains for non-migrated management pages.
- Focused UI tests and the affected OpenCraft type/lint gates pass.

## affected_paths

- `opencraft/apps/workbench-web/src/`
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
| `opencraft/design/README.md@worktree` | Workbench presentation contract. | Update invariants for a changed shell route. |
| `origin/codex/chat-demo-v2@98d772d06` | Requested reference implementation. | Port only compatible user-visible behavior. |

## evidence

- `npx tsx --test tests/lightvela-work-navigation.test.ts tests/lightvela-hermes-plugin.test.ts`: 82 passing tests.
- `npm run typecheck --workspace @opencraft/workbench-web --if-present` and `npm run typecheck --workspace @opencraft/plugin-lightvela-hermes --if-present`: passed.
- `npm run build:lightvela-web`: passed, including the LightVela product boundary check.
- Static production preview shows Skills and Cloud Storage as existing primary Sidebar entries, without a `Work` subgroup. Anonymous Skills navigation reaches the standalone page and correctly asks for a Hermes Host rather than a LightVela login.

## risks

- The source branch predates the current AppShell and overlaps user changes. Port behavior selectively rather than applying its patch.
- Management routes can hide the conversation surface; route selection must remain navigation-only.

## validation

- Run affected OpenCraft UI tests and type/lint commands identified from `opencraft/package.json`.
- Verify the Web route with an isolated local preview when available; authenticated Hermes operations remain a separate acceptance gate.

## decisions

- Reuse existing contributed views, preserving their current authority and error handling.
- Keep `runtime` and `diagnostics` in the existing management dialog; migrate only the requested Work surfaces.

## scan_scope

- `opencraft/apps/workbench-web/src`, `opencraft/plugins/lightvela-hermes/src`, `opencraft/tests`.

## scan_output

- Bounded source and reference-branch comparison only.

## handoff

- Complete locally. No commit, push, merge, preview publication, or external mutation was performed.
- A connected Hermes Host is still required to verify populated Profile Skills and mutations. Cloud Storage remains a separate authenticated cloud-instance surface.
