---
id: dsh-terminal-contract
type: task
scope: Align OpenCraft DSH terminal projection with HyperNode
triggers: [opencraft, dsh-terminal-contract]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/docs/chat-ui-architecture.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs / requirement_excerpt

User: “直接 100%遵循实现”. Follow the imported HyperNode DSH terminal lifecycle contract; prevent completion from erasing streamed messages.

## non_goals

No remote service changes, model calls, user data migration, commits or replacement of OpenCraft with HyperNode infrastructure.

## context_receipt

- opencraft/AGENTS.md and maintenance skill / verification reference
- opencraft/docs/chat-ui-architecture.md
- ref/hypernode/policy/src/services/dsh-engine-adapter.js and its tests
- appserver-session projectors and merge-turns
- Route query “opencraft DSH terminal lifecycle”: no pack matched; bounded exact search in adapter/projection/tests.

## acceptance

Summary-only terminal notifications preserve Items; visible Items settle first; interrupted partial output survives; failure is explicit; unknown/max-token/blocked reasons fail closed; duplicate terminal records have no effect. Live and historical projection agree.

## checkpoint

Copied HyperNode text helper function bodies verbatim into hypernode-dsh-text.js, verified against the imported source. OpenCraft host ports retain existing Item identities and synchronous notifications; no asynchronous pacer queue or SSH/model-gateway services are imported.

Focused DSH/session regression tests passed; real Workbench → compiler → DSH → synthetic local model smoke now asserts both user and assistant frames survive terminal completion. Full npm run gate, final Electron build, arm64 package, codesign verification and git diff check passed. No real model calls or user configuration writes. Package: release/dsh-terminal-final-preview/mac-arm64/OpenCraft Preview.app. New preview launched with an isolated profile; the old running window does not hot-update. Native startup inspection remains separate from the real-runtime synthetic completion evidence.
