# Hermes direct conversation approvals

## goal
Connect Hermes native approvals to OpenCraft's existing approval interaction surface.

## non_goals
- Group conversation changes, native Hermes changes, production or preview replacement.

## requirement_refs / requirement_excerpt
User conversation: 补齐 Hermes 审批，视觉遵循 OpenCraft 设计语言。

## interface_refs / data_structure_refs
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/adapter.ts`
- `opencraft/packages/appserver-protocol/src/server-requests.ts`
- Native `approval.request`, `approval.respond`, `session.resume.pending_approval`.
- Stable identity is Thread + native request ID; live session is a revocable routing identity.
- No action on display/dispose; only explicit allowed choice resolves backend approval.

## history_context
Current design: `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`.
Existing AppServer approvals and clarify bridge are authoritative; Hermes Desktop is a semantic reference, not a visual template.

## acceptance / validation
Focused approval, recovery, interaction mapping tests; affected package typechecks; package boundaries; real component verification.

## affected_paths
Hermes adapter/types/recovery, shared approval contract and renderer.

## context_receipt
- Root `AGENTS.md`: authority and authorization boundaries.
- `opencraft/AGENTS.md`: interaction ownership and shared UI rules.
- OpenCraft maintenance Skill + verification: preserve user control, distinguish source from deployment.
- Platform architecture: Thread lifecycle and embedded write lease.
- Chat architecture: blocking interaction response port.
- Context router: no match for `opencraft Hermes approvals native bridge ownership restore`; bounded searches in bridge and shared approval packages.
- Build matrix headless Web contract: isolated build only, correct same-origin Host profile; not a server replacement.

## risks / decisions
Permanent grants must be explicit scope metadata, never a fabricated Codex exec-policy amendment. Missing/malformed choices fail closed. No binary changes.

## stage
Source committed as `88a4dbe2c`, merged with current master and pushed on `feat/opencraft-hermes-approval-20261012`. MR [!5214](https://git.woa.com/wisp/mono2/-/merge_requests/5214) created. Merge attempted through the normal API; blocked by `Review check not passed. 409 conflict`. No deployment authorized.

## verified
- 176 combined core/approval/clarify/recovery/response/history/queue/Profile tests passed after integrating current master; approval-only suite has 17 passing tests.
- Bot-management gate: 32 passing tests, including group approval neighbors.
- Hermes adapter and shared protocol/core/runtime/broker package typechecks passed. Expo typecheck passed. Web supplemental ESNext/DOM check passed after preparing this checkout's dependencies.
- Real client/broker delivered persistent metadata through to native RPC boundary (Hermes gateway mocked at that boundary).
- Real Web approval component at 390px passed: idle never submits, keyboard activation respects focused control, permanent approval requires confirmation, restricted scopes hide persistent/session controls, no horizontal overflow. Reuses production styles; no feature-specific CSS introduced.
- Headless-target Web release build passed (`20261012-hermes-approval`); package boundaries, whitespace and formal-document impact checks passed.

## unverified
- Default Web typecheck still has pre-existing ES2022 library mismatches (`findLast`/iterator helpers). No configuration rewrite in this task; supplemental ESNext check passes.
- Full native Hermes inference/runtime and Expo device acceptance remain unverified; RPC success/failure/recovery tested using external-boundary fixtures, not production.
- Initial smoke dependency failure, dependency-reinstall concurrent test failure, headless build missing-profile failure, and assertion synchronization failure were corrected and rerun; not evidence of product behavior.

## restore / next_action
Await required Owner review on MR !5214, then merge via Gongfeng with normal checks. Keep preview and production untouched. Isolated build is in this checkout, not the running server.

## handoff
Commit and push completed under explicit user authorization; master merge remains blocked by the platform review gate. Current-master regression, boundaries and supplemental Web typecheck passed. Preview and production remain unchanged. Do not bypass review or describe this as merged.
