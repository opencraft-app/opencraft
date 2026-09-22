---
id: task-desktop-single-instance-review-20260921
type: task
scope: Read-only comparison of reference and OpenCraft desktop single-instance behavior.
triggers: ["desktop single instance", "prevent multiple launches", "profile lock review"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/apps/workbench-electron/src/main.ts, opencraft/apps/workbench-electron/src/desktop-directories.ts]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User asks whether ref/wb and ref/codex prevent multiple launches and whether OpenCraft lacks this mechanism.

## non_goals
- No changes to process locks, profiles, running windows or global application behavior.

## context_receipt / evidence
- Root/OpenCraft rules and maintenance skill; router returned no match. Bounded searches of reference startup code and OpenCraft Main/lifecycle/directory resolver.
- ref/wb README identifies recovered renderer code; startup-perf-marks.ts contains single_instance_locked. No requestSingleInstanceLock/second-instance implementation found in the inspected reference tree.
- ref/codex contains renderer startup and injected electronBridge; no native single-instance implementation found. Absence from a renderer reference does not prove absence in the original desktop app.
- OpenCraft Main resolves/sets userData before requestSingleInstanceLock. Failure quits the second process; second-instance routes login callbacks or calls ensureMainWindow -> lifecycle.show.
- lifecycle.show reuses/restores/focuses an existing window and coalesces concurrent show requests.
- Directory resolver provides stable OpenCraft and OpenCraft Preview default directories; explicit user-data-dir preserves isolated profile identity.
- The last packaged preview was intentionally launched with /tmp/opencraft-zencode-app.wFF9yk/profile, separate from the ordinary application profile, to preserve existing windows/configuration.

## validation / handoff
- desktop-directory-identity.test.ts + desktop-lifecycle.test.ts: 10 passed. These test directory/lifecycle policies, not an actual second-launch acceptance run.
- Conclusion: OpenCraft already has a profile-scoped single-instance guard; it does not enforce one process across deliberately distinct profiles/products. No runtime source changes or second app launches performed in this review.
