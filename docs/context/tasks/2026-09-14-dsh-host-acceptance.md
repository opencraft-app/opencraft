---
id: dsh-host-acceptance
type: task
scope: Fix page teardown and qualify DSH host lifecycle and scenarios
triggers: [opencraft, dsh-host-acceptance]
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

User requests implementation of refresh/unload lifecycle and full host/scenario
acceptance: exit, startup failure, timeout, cancellation, reconnect, tools and
approval correlation; multi-turn tools, restart during execution, continue
after interrupt, history and images.

## goal / non_goals

Fix confirmed defects and verify the matrix with isolated synthetic inputs.
Do not use real model credentials, change user logs, deploy or commit.

## context_receipt

OpenCraft maintenance, React best-practices and planning-with-files skills;
platform/chat architecture; source DSH migration and host files; root route
returned no matching pack, followed by bounded exact lifecycle searches.

## checkpoint

Root cause fixed: bootstrap now retires React before its sole owner cleanup;
consumer services retire before Host providers. Production UI reload/BFCache/
unload checks produce no runtime-error reports. Real DSH scenarios cover tools,
interrupt/continue, explicit restart and automatic SIGKILL recovery without
request replay, history identities and images. Fixture errors corrected:
background title requests were initially counted as tool steps, and the first
PNG fixture was malformed. Neither required weakening production validation.

Full gate hit an unrelated browser portal source-pattern test in files this
task did not modify. Focused tests pass; remaining independent gates and Mac
packaging are being run. Task remains active until gate ownership is resolved.

Final checkpoint: the independent browser test and fresh complete gate pass
without this task editing those files. Final DSH suite has 28 passing tests.
Real-engine acceptance passes explicit restart and automatic crash recovery,
without repeating inference. UI reports remain clean through reload/BFCache/
unload. Typecheck, final Electron build, arm64 package and codesign verification
pass. Opened release/dsh-host-acceptance-preview/mac-arm64/OpenCraft Preview.app
with an isolated profile and verified its root/composer mount. No paid model
requests, user-data changes, commits or pushes.
