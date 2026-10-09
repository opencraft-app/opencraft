---
id: agent-bot-rail-client-navigation
type: task
scope: Dual-site Bot rail client navigation and session catalog loading.
triggers: ["agent bot rail", "bot switch navigation", "embedded session catalog"]
owner: pablozhong
authority: primary
source_of_truth:
  - wiki/prd-docs/2026-10-08-agents-bot-rail.md
  - opencraft/docs/chat-ui-architecture.md
status: active
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: task
derived: false
---

## goal
Make switching Bot avatars use client navigation after hydration, without a full document reload or transient empty-session rows.

## non_goals
- No Bot API, entitlement, route destination, or visual redesign changes.
- No merge, deployment, or production change in this task.

## requirement_ids / requirement_refs / requirement_excerpt
- User screenshot and report, 2026-10-09: switching Bot shows a full-page skeleton and feels too heavy.
- User follow-up, 2026-10-09: the sidebar briefly shows “默认对话”, then loading text, then the actual chat list during a Bot switch.
- Existing `docs/context/tasks/2026-10-08-agents-bot-rail-implementation.md`: selecting another Bot enters its new chat and isolates session state.

## interface_refs / data_structure_refs
- `frontend/src/pages/marketing/agent-bot-rail.tsx`: real `href` remains available before hydration and for modified clicks.
- `frontend/src/pages/marketing/agent-settings-page.tsx`: `prepareBotSwitch` clears old session state; `handleSelectBot` changes `?bot=` through `useAppNavigate`.
- `frontend/src/lib/react-router-app-navigation.tsx`: app navigation uses React Router in the client.
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`: Thread catalog's initial query is pending before the Host is ready.
- `opencraft/apps/workbench-web/src/app.tsx`: embedded sessions bridge owns the loading signal consumed by the site sidebar.

## history_context
- current_design_refs: `docs/context/tasks/2026-10-08-agents-bot-rail-implementation.md` and `frontend/openspec/specs/agents-workbench.md`.
- relevant_evolution: MR !5100 added native Bot links so a click before hydration can still navigate.
- superseded_refs: none.

## acceptance
- An ordinary click on another Bot prevents default document navigation, updates `?bot=`, and selects the target Bot's new chat.
- Before hydration, the link still has a working `href`; modified clicks keep browser behavior.
- Bot rail and account navigation remain mounted during an ordinary switch.
- On an uncached Bot switch, the sidebar waits without visible placeholder text; it shows either the target Bot's chat list or a confirmed empty-list entry after the first catalog read.

## affected_paths
- `frontend/src/pages/marketing/agent-bot-rail.tsx`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- Focused tests under `frontend/src/pages/marketing/__tests__/`.
- `opencraft/apps/workbench-web/src/app.tsx` and `runtime/appserver-runtime-context.tsx`.

## required_context
- `frontend-product-surface`, `service-frontend`, `site-environment-routing`.

## context_receipt
| File | Reason | Use |
|---|---|---|
| `docs/context/project/services/frontend.md@origin/master` | Service boundary | Dual-site checks |
| `docs/context/domains/site-environment-routing.md@origin/master` | Region boundary | Same behavior on both sites |
| `frontend/AGENTS.md@origin/master` | Local validation | Frontend gates |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@origin/master` | Dependency neighbor | Inspect existing tests and OpenSpec |
| `frontend/openspec/specs/agents-workbench.md@origin/master` | Existing UI scope | Keep the workbench behavior |
| `docs/context/domains/agent-gateway-runtime.md` | OpenCraft runtime boundary | Keep session loading owned by the catalog |
| `docs/context/project/services/opencraft.md` and `opencraft/AGENTS.md` | OpenCraft validation | Run service checks and rebuild embedded asset |
| `docs/context/project/upstream-subtrees.md` | Source ownership | Edit mono2 OpenCraft source only |
| `docs/context/domains/identity-access.md` | Session boundary | Keep account-scoped cache intact |
| `frontend/DESIGN.md` and `opencraft/docs/platform-architecture.md` | Current UI/runtime rules | Preserve client navigation and Host failure behavior |

## evidence
- `origin/master` fetched at `c72e37f45`; inactive Bot anchor invokes `onSelect` without `preventDefault`, so native navigation follows.
- Focused regression test first failed on `normalClick.defaultPrevented === false`, then passed after the fix.
- The Next `/agents` layout keeps `AgentsPageClient` mounted across query navigation; `useAppNavigate` maps to `router.replace` there.
- `useThreadCatalog` returned `query.isFetching` alone; while its query is disabled before Host readiness, React Query can be pending with `isFetching=false`, so an unconfirmed empty list was published as settled.

## risks
- A client switch must reset old Bot chat state; use the existing `handleSelectBot` path.
- Modified clicks and pre-hydration clicks must retain native navigation; preserve the anchor.
- A confirmed empty catalog must still expose the default conversation entry, including query failure or single-session fallback behavior.
- A failed initial Host connection must not keep announcing catalog loading indefinitely; the main chat owns the failure and retry presentation.

## validation
- Focused behavior and sidebar tests, `pnpm check`, relevant build, `git diff --check`, change-impact validation if mapped.
- Focused tests: 41 passed in 2 files.
- `pnpm check`: i18n/docs passed; TypeScript 166 current vs 171 baseline, 0 new.
- `pnpm build` (CN) and `pnpm build:global`: passed.
- Follow-up: 48 focused frontend tests passed; frontend `pnpm check` passed with 0 new TypeScript diagnostics; CN `pnpm build` passed.
- OpenCraft workbench typecheck, embedded release build, and `npm run test:chat` (600 tests) passed. Generated embedded script at 5174 references the rebuilt asset `a-Dj-Z9hkq.js`.
- `check:mono2-agent-console`, explicit docs-impact check, and `git diff --check` passed.
- User reviewed the local 5174 preview and confirmed the interaction looks okay.
- CR !5117 follow-up: CN and global focused tests each passed 41/41; OpenCraft embedded tests passed 221/221. Frontend `pnpm check` reported 0 new TypeScript diagnostics; OpenCraft workbench typecheck, embedded release build, sync check, and documentation validation passed.

## decisions
- Keep an anchor and intercept only ordinary unmodified clicks after hydration; no new router abstraction.
- Publish catalog loading while the query is pending or fetching, except when the Host has entered its terminal error phase. Keep the sidebar loading announcement accessible but visually hidden, without delaying or hiding an already cached list.
- Keep Bot avatar clicks on the existing client `replace` path. The native anchor was added for pre-hydration and modified-click behavior, not as a product requirement for ordinary-switch browser history; the PRD only specifies the destination.

## scan_scope
- `frontend/src/pages/marketing/agent-bot-rail.tsx`, `agent-settings-page.tsx`, adjacent tests and app navigation.

## scan_output
- Exact `rg` and `git grep` results summarized above; no broad scan retained.

## handoff
- Local implementation and validation complete in isolated worktree. The 5174 preview serves the rebuilt embedded asset; the user approved its appearance and authorized a new MR. No merge or production deployment is authorized.
