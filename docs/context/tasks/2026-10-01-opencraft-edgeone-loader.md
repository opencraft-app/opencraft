## goal
Ensure the OpenCraft Embedded Workbench loader and its assets are present in the EdgeOne upload tree for enabled frontend release artifacts.

## non_goals
- Do not publish, promote, or change a production service.
- Do not change OpenCraft runtime or session protocols.

## requirement_ids / requirement_refs / requirement_excerpt
- User DevTools screenshot (2026-10-01): `GET /__opencraft/embedded-workbench.js` returned 404 and `[opencraft-embed] startup failed` at `stage: module`.

## interface_refs / data_structure_refs
- `frontend/release-matrix.json`: enabled `embeddedWorkbench.scriptPath` is `/__opencraft/embedded-workbench.js` for the production EdgeOne combos.
- `frontend/scripts/deploy-edgeone-pages.mjs#resolveDeployDir`: uploads `.edgeone` when that directory exists.

## history_context
- current_design_refs: `docs/engineering/domains/release-gitops.md` Embedded Workbench artifact contract.
- relevant_evolution: current `master` stages `out/__opencraft` after the EdgeOne projection has copied `out` to `.edgeone/assets`.
- superseded_refs: none.

## acceptance
- A focused regression using the real EdgeOne projection script finds the loader, version, and hashed asset under `resolveDeployDir(...)/assets/__opencraft/`.
- Existing frontend artifact tests and applicable frontend gates pass.

## affected_paths
- `frontend/scripts/build-release-artifacts.mjs`
- `frontend/scripts/build-release-artifacts.test.ts`

## required_context
- `site-environment-routing`, `frontend-product-surface`, `service-frontend`, `release-gitops`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/domains/site-environment-routing.md@master` | CN/global delivery boundary | Validate both release combos |
| `docs/context/project/services/frontend.md@master` | Frontend service boundary | Focused frontend validation |
| `docs/context/domains/release-gitops.md@master` | Source versus release distinction | Do not claim production fixed |
| `frontend/AGENTS.md@master` | Frontend commands and code rules | Validation |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@master` | Static output neighbor | Inspect adjacent build test |
| `docs/engineering/domains/release-gitops.md@master` | Formal artifact invariant | Stage before projection |

## evidence
- 2026-10-01: DevTools shows 404 at `/__opencraft/embedded-workbench.js`; read-only HTTP GET returned 404 with `eo-cache-status: MISS`.
- Baseline focused test failed because the loader was absent from `.edgeone/assets/__opencraft/` (1 failed, 11 passed).
- `runFrontendArtifactBuildCommand` called `fix-next-static-html-lang.mjs` before `stageOpenCraftEmbeddedWorkbench`; the projection copies `out` into `out/.edgeone/assets`, and `resolveDeployDir` selects `.edgeone`.
- After moving staging before projection, the artifact and projection tests passed (19/19).

## risks
- Source changes do not repair the live site until an authorized release publishes a corrected artifact.
- Preserve the existing build output layout and avoid unrelated release changes.

## validation
- `pnpm exec vitest run scripts/build-release-artifacts.test.ts scripts/fix-next-static-html-lang.test.ts --api.host 127.0.0.1`: 19/19 passed.
- `pnpm check`: passed; 166 current TypeScript diagnostics, 171 baseline, 0 new.
- `pnpm build`: passed; 106 static pages. This ordinary build did not include an OpenCraft dist input.
- `git diff --check` and documentation validation: passed. Stage-aware change impact validation will run after explicit staging.

## decisions
- Move staging before the real EdgeOne projection step and assert the actual upload tree in the focused regression.

## scan_scope
- `frontend/scripts/build-release-artifacts*`, `frontend/scripts/fix-next-static-html-lang.mjs`, `frontend/scripts/deploy-edgeone-pages.mjs`, release matrix and formal release design.

## scan_output
- Bounded terminal evidence in this task; no saved scan artifact.

## handoff
- Local fix and focused validation complete in the isolated worktree. The user authorized an MR on 2026-10-01. A new artifact build and separately authorized EdgeOne release are required for production recovery.
