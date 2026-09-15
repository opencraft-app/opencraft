---
id: dsh-engine-migration
type: task
scope: Transplant HyperNode DSH execution core into OpenCraft local host
triggers: [opencraft, dsh-engine-migration]
owner: mingyuxiao
authority: primary
source_of_truth:
  - opencraft/design/dsh-engine-migration.md
status: retired
reviewed_at: 2026-09-14
review_due: 2026-10-14
revision: 1.0.0
precedence: task
derived: false
---

## requirement_refs / requirement_excerpt

Current user request: “全部移植”, following the six confirmed DSH parity findings.

## goal / non_goals

Migrate Turn/Item ledger, event handling, tools and terminal control as one
source-derived core. Keep OpenCraft model/credential ownership and local
HTTP/mux process transport; no SSH tenancy, remote deployment, paid requests,
user-data migration or commits.

## history_context

Prior dsh-terminal-contract fixed empty full completion but copied only text
helpers. This migration supersedes that partial architecture.

## context_receipt

- opencraft/AGENTS.md, maintenance skill and verification reference
- opencraft/docs/platform-architecture.md and chat-ui-architecture.md
- ref/hypernode TurnManager, dsh-engine-adapter, dsh-appserver-projection and dsh-engine-worker
- opencraft DSH source, interaction adapter and regression tests
- Context route “opencraft DSH migration” had no match; bounded exact source searches followed.
- Planning-with-files tracks phases in opencraft/design/dsh-migration/.

## validation / checkpoint

Source parity check verifies 30 imported methods. Focused migration/DSH/host
tests, real runtime synthetic completion, production UI send/reload and full
gate pass. Final Electron build, arm64 package, codesign and native composer
startup verified. See migration plan/progress for source adaptations and
failed attempts. The independent Host registry disposed warning during UI
reload/unload remains outside this execution-core migration.
