---
id: mr-5124-conflict-resolution-20261010
type: task
scope: Resolve merge conflicts between Agent dressup MR !5124 and master.
triggers: ["MR 5124 conflict", "agent dressup merge"]
owner: keria
authority: primary
source_of_truth:
  - frontend/src/i18n/generated/
  - opencraft/scripts/sync-mono2-agent-console.mjs
status: active
reviewed_at: 2026-10-10
review_due: 2026-11-10
revision: 1.0.0
precedence: task
derived: false
---

## goal
Resolve !5124 conflicts against master while retaining dressup and master locale features.

## non_goals
- Merge the MR or deploy either site.

## requirement_ids / requirement_refs / requirement_excerpt
- [!5124](https://git.woa.com/wisp/mono2/-/merge_requests/5124): user requested conflict resolution.

## interface_refs / data_structure_refs
- `frontend/scripts/i18n-extract.mjs` owns generated dictionaries; shared keys must retain identical translations.
- `opencraft/scripts/sync-mono2-agent-console.mjs` owns the vendored Agent Console and `UPSTREAM.json`.

## history_context
- current_design_refs: `docs/engineering/domains/site-environment-routing.md`, `frontend/DESIGN.md`.
- relevant_evolution: MR head `acd8c3418d`, target master `3bc4384e53` at conflict reproduction.
- superseded_refs: none.

## acceptance
- No unresolved index entries; generated dictionaries and OpenCraft mirror agree; frontend checks and focused tests pass.

## affected_paths
- `docs/engineering/domains/site-environment-routing.md`
- `frontend/src/i18n/generated/`
- `opencraft/plugins/lightvela-hermes/src/upstream/mono2/`

## required_context
- `tapd-gongfeng-delivery`, `site-environment-routing`, `service-frontend`, `service-opencraft`, `upstream-subtrees`, `agent-gateway-runtime`.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `docs/context/flows/tapd-gongfeng-delivery.md@acd8c3418d` | MR write gate | Hold commit and push for explicit confirmation |
| `.agents/skills/gongfeng/SKILL.md@acd8c3418d` | Gongfeng access | Inspect MR state |
| `docs/context/domains/site-environment-routing.md@acd8c3418d` | Locale boundary | Preserve both site behaviors |
| `docs/context/project/services/frontend.md@acd8c3418d` | Frontend gates | Run check and focused tests |
| `docs/context/project/services/opencraft.md@acd8c3418d` | OpenCraft boundary | Verify generated mirror |
| `docs/context/project/upstream-subtrees.md@acd8c3418d` | Upstream ownership | Keep mono2 as source |
| `docs/context/domains/agent-gateway-runtime.md@acd8c3418d` | Agent runtime | Avoid changing unrelated runtime behavior |
| `frontend/AGENTS.md@acd8c3418d` | Service instructions | Generate dictionaries and run gates |
| `opencraft/AGENTS.md@acd8c3418d` | Service instructions | Rebuild generated mirror |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@acd8c3418d` | Adjacent generator | Check i18n script and locale tests |
| `docs/context/tasks/TASK-TEMPLATE.md@acd8c3418d` | Task pack structure | Record evidence and handoff |

## evidence
- `git merge --no-commit --no-ff origin/master` reproduced 18 conflicts.
- Common locale keys had zero differing values; combined key sets and regenerated dictionaries.

## risks
- New Thai locale lacked translations for dressup strings; translated 90 new keys and verified placeholders.
- `UPSTREAM.json` sourceRevision must be regenerated after the merge commit.

## validation
- `pnpm check`: passed; 164 current TypeScript diagnostics, 171 baseline, 0 new.
- Focused frontend tests: 3 files, 87 tests passed after correcting an outdated order assertion.
- `npm run check:mono2-agent-console`: passed.
- `npm run test:cloud-desktop`: 142/142 passed after repository postinstall.
- `validate_documentation.py`: 0 first-party broken links; `validate_change_impact.py --staged`: passed.
- `pnpm build`: passed; static routes and SEO checks completed.
- OpenCraft full gate reached extension tests after passing type checks and 142 cloud desktop tests; stopped on `im-chat-service.test.ts` (2 sends versus expected 1). The test also fails in isolation; its merged source equals `origin/master` and is outside this MR.
- `npm run typecheck --workspace @opencraft/workbench-web --workspace @opencraft/plugin-lightvela-collaboration --workspace @opencraft/plugin-lightvela-hermes`: passed.

## decisions
- Keep both independent sections of the site routing document.
- Regenerate language files and OpenCraft mirror from their source scripts.

## scan_scope
- `frontend/src/i18n/generated/`, `frontend/scripts/i18n-extract.mjs`, `opencraft/scripts/sync-mono2-agent-console.mjs`.

## scan_output
- Bounded search located the dictionary generator, mirror generator, and focused locale tests.

## handoff
- Await verification and explicit commit/push confirmation.
