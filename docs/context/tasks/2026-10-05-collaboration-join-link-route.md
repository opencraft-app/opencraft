---
id: collaboration-join-link-route-2026-10-05
type: task
scope: Restore the existing authenticated join-link operation in the runtime route composition.
triggers: ["collaboration join-link route"]
owner: wisp/mono2-maintainers
authority: primary
status: active
reviewed_at: 2026-10-05
review_due: 2026-11-05
revision: 1.0.0
precedence: task
---

## goal

Make the deployed OpenAPI join-link acceptance path reachable through the normal authenticated Collaboration runtime.

## non_goals

- No schema, migration, OpenAPI, generated code, identity authority, or Tencent group-model changes.
- No credential values, production changes, or manual IM membership bypass.

## requirement_ids / requirement_refs / requirement_excerpt

- Continue the authorized Collaboration real two-party acceptance work; the user authorized creating test identities.
- Source MR !4953 and Beijing release MRs !4959/!4960 are merged.

## interface_refs / data_structure_refs

- `collaboration/platform/v1/openapi.yaml`: existing `POST /join-links/accept` and its `JoinResult`.
- `collaboration/internal/transport/http/invite_handler.go`: existing strict handler and application service.
- Preserve authentication, one-use invite consumption, and idempotent destination semantics.

## history_context

- `current_design_refs`: `collaboration/README.md`, frozen OpenAPI baselines.
- `relevant_evolution`: !4953 exposes the gateway path and client consumer; bootstrap and HTTP mux still omit it.
- `superseded_refs`: migration-era standalone login is not a runtime test-account creation path.

## acceptance

- An unauthenticated request is rejected with 401, not route-not-found.
- An authenticated join returns its Server, Member and landing Channel.
- Replaying the same idempotency key preserves the destination.
- Regression fails before wiring and passes afterward.

## affected_paths

- `collaboration/internal/bootstrap/auth_api.go`
- `collaboration/internal/transport/http/human_handler.go`
- `collaboration/internal/bootstrap/join_link_api_test.go`
- `collaboration/README.md`

## required_context

- Root and Collaboration AGENTS; route query found no matching pack, so bounded exact searches were used.

## context_receipt

| File | Reason | Use |
|---|---|---|
| `AGENTS.md` | Repository boundaries | Isolated worktree; explicit confirmation before delivery writes |
| `collaboration/AGENTS.md` | Behavior workflow | RED → GREEN; no generated edits |
| `docs/context/tasks/TASK-TEMPLATE.md` | Work record | Preserve evidence and outstanding work |
| `collaboration/README.md` | Identity mode | Create accounts through LightVela UserAuth only |
| `.agents/context/change-impact.json` | Documentation scope | Collaboration implementation does not match a design-impact rule |

## evidence

- Two synthetic accounts registered through LightVela UserAuth; both Collaboration profiles and IM sessions are ready.
- New test Server and default topic reached ready, confirming topic provisioning works after the user enabled it.
- Real authenticated receiver `POST /v1/collaboration/join-links/accept` returns 404 `route_not_found`.
- Bounded source search found both bootstrap allowlist and HTTP mux missing the existing operation.
- RED: bootstrap regression failed with 404 `route_not_found` instead of the expected authentication rejection.
- GREEN: registering both existing routing layers made the end-to-end join and same-key replay pass.
- Go full service tests and vet passed; bootstrap/HTTP/invite application race checks passed.
- Documentation integrity and explicit-file docs-impact checks, credential scan and diff checks passed.
- Both synthetic identities reached SDK_READY in separate real Chromium contexts using Tencent SDK 3.6.7; sender topic/history reads returned code 0 with empty history. No real messages were sent.

## risks

- Local patch cannot repair deployed runtime until normal code review and release.
- Retain the existing invite and idempotency key for resumed real acceptance.

## validation

- Focused bootstrap regression RED then GREEN; bootstrap/HTTP/application invite tests and vet/race as appropriate.
- No contract or generated output changes; documentation and diff checks.

## decisions

- Wire the existing strict handler in both routing layers; reuse the existing auth and application semantics.

## scan_scope

- Bootstrap route composition, HTTP mux, invite handler, and existing platform integration fixtures.

## scan_output

- No external scans or credentials included.

## handoff

- Real group/private messaging remains blocked on the missing join route.
- Worktree is detached and isolated; no commit, push, MR, approval or release performed.
- Local repair is ready for review; repository P0 requires explicit confirmation before committing, pushing and creating a new MR.
