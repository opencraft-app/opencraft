---
id: opencraft-native-thread-pinning-20261008
type: task
scope: Native conversation pinning without bridge persistence.
triggers: ["opencraft native thread pinning"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/design/invariants.md
status: candidate
reviewed_at: 2026-10-08
review_due: 2026-11-08
revision: 1.0.0
precedence: task
derived: false
---

# Native Thread pinning

## goal
Conversation menus can pin/unpin supported native sessions; pinned conversations survive reload through the native backend and stay visible beyond the recent catalog window.

## non_goals
- No Hermes changes, bridge pin database, browser pin persistence, DSH fallback, drag ordering or preview replacement.

## requirement_ids / requirement_refs / requirement_excerpt
- Current user conversation: pin individual sessions, persist across refresh, no extra bridge storage, Hermes must remain unchanged.

## interface_refs / data_structure_refs
- `opencraft/packages/appserver-protocol/src/methods.ts`: handwritten normalized wire contract.
- Codex native `threadSection/list`, `thread/section/move`, section-filtered `thread/list`.
- Hermes Dashboard `PATCH /api/sessions/{id}` with `pinned` and owning `profile`; GET native metadata with pinned backfill.
- Pin discovery is distinct from method admission; missing native support hides the action, transient failure is not empty success.

## history_context
- current_design_refs: `opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`, `opencraft/design/invariants.md`.
- relevant_evolution: native lifecycle controls already have a capability-gated menu and catalog query owner.
- superseded_refs: none.

## acceptance / validation
- Protocol/provider/runtime tests: persistence by re-read, older pinned summary backfill, profile isolation, unsupported peers, failure, stale reads, serialized writes, no resume.
- Affected typechecks, boundaries, real Web sidebar/menu smoke; no paid inference or changes to user sessions.

## affected_paths
- appserver-protocol, workbench-runtime, opencraft-daemon, lightvela-hermes, workbench-web, focused tests and formal design.

## context_receipt
- Root and OpenCraft AGENTS; maintenance skill and verification reference: authority, no hidden deploy authorization.
- Router `opencraft thread pinning provider native metadata sidebar`: no pack matched; bounded search of lifecycle/projection/catalog paths.
- Identity/runtime domain packs and frontend-runtime adjacency previously read while checking HTTP; Hermes history cancellation test checked as neighbor.
- Codex recovered 26.930.31428 renderer: reserved native section identity, not display name; Hermes local reference 3c3ab69a: native metadata PATCH/profile/lineage/backfill.

## decisions / risks
- Native storage remains authoritative; the bridge only adapts wire contracts. In-memory command ordering and read fences are not a second persistent pin set.
- Runtime capabilities require successful current-connection discovery. Old/unsupported Codex must not gain a fabricated pin action.
- Hermes HTTP metadata must use the existing TAT owner and session token; no runtime activation to resolve a pin target.

## evidence / scan_scope / scan_output
- Clean checkout; new branch `feat/thread-native-pinning-20261008` from fetched origin/master. No external writes.
- Scoped files above; no secret values read or logged.
- Focused protocol/runtime/catalog/lifecycle/history checks: 37/37 passed; native pin/catalog/Codex adapter regression set: 43/43 passed.
- Five affected workspace typechecks, i18n, platform boundaries, Web production build and diff whitespace check passed.
- Real Sidebar and shared Radix menus passed desktop/touch × light/dark smoke: pin/unpin, unsupported menu hiding, complete pin visibility without consuming recent slots, no duplicate row after acknowledgement. Fixture replaces external mutation callbacks, not the Sidebar/menu DOM.
- Fresh isolated home with installed preview Codex 0.160.0: real `threadSection/list` exposes reserved pin section; native `thread/list` accepts `section_position` and section filtering. No user session, model call or real pin mutation.
- Hermes native reference allows NULL title/preview; adapter normalizes these legitimate empty summaries. Unsupported HTTP and transient failures remain distinct. Hermes source is unchanged; real remote TAT/HTTP pin writes remain unverified.
- Removed speculative section notification names absent from recovered Codex. Confirmed bridge mutations emit normalized invalidation; external changes refresh by catalog read/focus, not an invented native push contract.
- Documentation validation and full changed-file impact mapping passed; mapping requires maintainer review for later MR. `--staged` check sees an empty set because no files were staged.
- Global context-catalog validation remains failing on existing repository task schema, instruction-size and secret-scan findings; it is not counted as passed. Initial wrong-directory generated empty catalog was moved to ignored runtime storage, not retained as source.

## handoff
- Source committed as `b7e8ae711`; latest master incorporated by merge `ec5447b2e`, preserving desktop changes. Post-merge focused regression checks passed 62/62, five workspace typechecks, i18n, boundaries and desktop/touch × light/dark Sidebar smoke passed.
- Branch pushed; [MR !5064](https://git.woa.com/wisp/mono2/-/merge_requests/5064), global ID 27568538, targets master. Normal merge refused with `Review check not passed. 409 conflict`; maintainer approval is required. No review rule changes or bypass. Master is not yet updated by this feature.
- Current public preview remains unchanged, with no replacement or restart authorized in this request.
- Native storage is the sole pin authority; DSH/unsupported peers hide the action. Refresh re-reads native metadata. Deployment and real remote Hermes write acceptance are separate remaining delivery steps.
