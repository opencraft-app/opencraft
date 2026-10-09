---
id: collaboration-hidden-lab-2026-10-09
type: task
scope: Beijing-only hidden collaboration laboratory with shared Tencent IM services.
triggers: ["collaboration hidden lab"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-09
review_due: 2027-01-07
revision: 1.0.0
precedence: task
derived: false
---

## goal
Make the existing Human collaboration capability available behind an explicit
browser show() gate, and verify real Tencent IM connection on localhost and the Beijing test site.

## non_goals
- No Shanghai or international integration, token forwarding or production operations.
- No edits to ref/velachat, new login authority, private key, schema or migration.
- No Computer, Task or Reminder product expansion.

## requirement_ids / requirement_refs / requirement_excerpt
- User requested hidden laboratory collaboration chat, enabled by show().
- Latest steering limits all work to Beijing test and localhost; no Shanghai linkage.

## interface_refs / data_structure_refs
- POST /v1/collaboration/me/im/session returns a server-issued HumanImSession.
- Existing Collaboration services, shared client-core types and Tencent SDK adapter.
- frontend session-context and readStoredAuthToken retain account authority.

## history_context
- current_design_refs: opencraft/docs/platform-architecture.md and docs/engineering/domains/agent-gateway-runtime.md.
- relevant_evolution: existing OpenCraft collaboration plugin; frozen VelaChat subtree c0f8fa280d33ea3eb6edc8a32a679e0847d28def.
- superseded_refs: independent VelaChat login is not a LightVela login adapter.

## acceptance
- Default-hidden direct routes neither load the IM panel nor issue collaboration requests.
- show() opens the entry without reload; a second show() unmounts its owner.
- Only the selected https://lightclaw.tech authority is eligible; Shanghai and international requests are rejected before fetch.
- The Human laboratory does not require a Bot or paid Agent entitlement.
- Real localhost page obtains an IM session, reaches the workspace and closes on hide.

## affected_paths
- frontend route, local feature gate, lazy panel, account adapter and translations.
- Beijing service-gateway collaboration CORS origin in its GitOps overlay.
- shared/vela-collaboration-web and OpenCraft compatibility exports/package lock.

## required_context
- frontend-product-surface, service-frontend, site-environment-routing, service-collaboration.

## context_receipt
| File | Reason | Use |
|---|---|---|
| AGENTS.md, frontend/AGENTS.md | Scope and gates | Isolated worktree, frontend check/test/build |
| frontend/DESIGN.md | UI reuse | Existing product header and routed panel |
| docs/context/project/services/frontend.md | Router | Account/environment responsibility |
| docs/context/domains/site-environment-routing.md | Router | Restrict eligibility to Beijing |
| docs/context/project/services/collaboration.md | Router | Backend owns IM mapping and session |
| opencraft/AGENTS.md, opencraft/.agents/skills/opencraft-maintenance/SKILL.md | Shared extension change | Preserve owner and teardown order |
| opencraft/docs/platform-architecture.md | Account architecture | No second credential store |
| frontend/src/contexts/__tests__/runtime-config-context.test.ts | Direct test neighbor | Existing hidden-feature precedent |
| docs/context/project/adjacency/frontend-runtime-openspec-i18n.md | Adjacency | Generated locale validation |

## evidence
- Source worktree based on master 1b9faf845e2ffdfb09b7430f518c03b910217407.
- Credential-free Beijing collaboration endpoint recognizes the route; default Shanghai endpoint does not.
- Hidden gate regression failed before its module existed; the feature tests then passed.
- 85 existing Collaboration service, plugin and IM adapter regressions passed after extraction.
- 8 visibility, account-isolation and lazy-route regressions passed.
- Real localhost browser: zero collaboration requests before show(); Beijing IM session
  and all workspace requests returned 200; SDK-ready workspace rendered existing group
  history; second show() removed the panel and restored the hidden state.
- Browser evidence: /data/collaboration-lab-evidence-20261009/localhost.json and localhost-connected.png.
- pnpm check passed: 166 existing diagnostics, 171 baseline, zero new diagnostics.
- Beijing-configured pnpm build passed, including static routes and SEO checks.
- Repository documentation validation passed with zero errors.
- Full pnpm test was attempted and did not pass: failures in subscription, FaceID,
  model catalog, international artwork and debug command tests; cloud-desktop worker
  exhausted its heap and stalled termination. No baseline or tests were relaxed.
- Detached unmodified master 1b9faf845 reproduced the debug-command assertion and
  cloud-desktop heap exhaustion; other full-suite failures remain unclassified.
- OpenCraft generated routes/locales synchronized in a separate commit; the
  read-only gate verified all 130 console files. ref/velachat retains tree
  0caf6978e5d4ebfe99db114e270209fc97323266.

## risks
- show() controls discovery only; backend session authentication remains mandatory.
- Endpoint eligibility does not prove a user's session is valid or IM is ready.
- Never substitute a Beijing token for a Shanghai account or implicitly change site authority.

## validation
- Focused frontend gates, existing plugin tests, documentation and console synchronization checks.
- Frontend check/test/build plus real localhost browser evidence; record any baseline failures separately.

## decisions
- Share production sources through a package instead of copying the reference Expo app.
- Preserve OpenCraft exports so its extension lifecycle and consumers retain compatibility.
- Frontend laboratory owns one account-bound scope and waits for prior logout before reconnecting.

## scan_scope
- Shared package imports, frontend lab closure, endpoint paths and generated locale additions.

## scan_output
- Evidence outside Git at /data/collaboration-lab-evidence-20261009; no session tokens or UserSig logged.

## handoff
- Implementation and real localhost IM connection verified. Preview uses Beijing only:
  http://localhost:5198/agents/labs/collaboration/; execute show() to toggle visibility.
- Full-suite failures remain baseline limitations; no Shanghai production rollout occurred.
- Local commits: dd89ab8f7 (source) and 6120eb24e (generated console sync).

## Beijing test delivery
- Integrated origin/master a6335c674; required Malay locale entries added and console regenerated.
- Integrated frontend check: 166 baseline diagnostics, zero new; 16 focused tests and Beijing build passed.
- Source MR !5134: https://git.woa.com/wisp/mono2/merge_requests/5134.
  Merge request was rejected with Review check not passed; master is not merged.
- Public frontend deployment 8af0b894-7583-43c5-b3d6-090400cfd3e5 uses build
  beb91234237bc0b43919ec0ed001493df38ea19f; 5363 manifest entries verified,
  including 672 preserved embedded-workbench paths from the latest concurrent release.
- Beijing gateway CORS now allows exactly https://lightclaw.pages.dev in addition
  to the existing localhost origins. UID/resourceVersion guarded config and
  deployment updates completed; both gateway replicas rolled out successfully.
- Public browser: hiddenRequests=0; show() loads real IM session HTTP 200,
  real Tencent IM group history renders; second show() restores hidden state.
  Evidence: /data/collaboration-lab-evidence-20261009/beijing.json and beijing-connected.png.
- Focused gateway TestCollaboration cases passed.
- Public entry: https://lightclaw.pages.dev/agents/labs/collaboration/.
- CORS GitOps MR !5135 merged into gitops at 4090f031266426bb4e7a3fd9d361a96c78510469.
  Runtime rollout and public browser were verified directly; Argo Application CRs
  are unavailable on the target cluster, so Argo Synced/Healthy is not claimed.
