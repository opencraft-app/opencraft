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
Source implementation and scoped verification complete. User authorized commit, push and merge into master on 2026-10-12; Git delivery in progress, no deployment authorized.

## verified
- 175 combined core/approval/clarify/recovery/response/history/queue/Profile tests passed; newest reminted-session regression raises approval-only suite to 17 passing tests.
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
Integrate on a dedicated approval branch, validate against current master, push and merge via Gongfeng with normal checks/review. Keep preview and production untouched. Isolated build is in this checkout, not the running server.

## handoff
Implementation delivery is proceeding under explicit commit/push/merge authorization. Preview and production remain unchanged; merge results must be verified from Gongfeng and remote master before reporting completion.
