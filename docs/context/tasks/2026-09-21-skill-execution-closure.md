---
id: task-skill-execution-closure-20260921
type: task
scope: Close Skill execution, reactive discovery, remote Profile catalog and browsing gaps.
triggers: ["Skill execution closure", "reactive Skill catalog", "Hermes Skill paths"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth: [opencraft/docs/chat-ui-architecture.md, opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts]
status: retired
reviewed_at: 2026-09-21
review_due: 2026-10-21
revision: 1.0.0
precedence: task
derived: false
---

## goal / requirement_refs
User approved implementing the remaining gaps identified by the Skill audit.

## non_goals
- No production changes, Skill installation, account use, paid inference, commits or package replacement.
- No fabricated filesystem paths or Codex-only Apps/marketplace policies.

## context_receipt / history_context
- Root/OpenCraft rules, maintenance checklist, Chat UI contract and preceding Skill gap audit. Router no match; bounded exact code/SDK searches.
- Installed dsh-host-apiproxy accepts text/image only; native dsh-tool-skill agent/pre-step recognizes bounded /name gestures and loads userInvocable Skill definitions.
- dsh-skill service is path/name/scope authority. Hermes reference /api/skills/content returns a canonical path; current Profile handler discarded it.

## decisions / acceptance
- Validate explicit Skill name/path against the executing Agent's native registry, then use DSH native user gesture. Reject disabled/stale/mismatched references rather than dropping them. Test actual native pre-step loading with synthetic context, no model.
- Subscribe the open picker to catalog changes; invalidate in-flight generations and refetch active scope without stale insertion.
- Remote Profile-scoped hosts discover paths from authoritative content responses, with bounded reads and no filesystem guessing.
- Remove silent 50-item browse truncation; retain name/path identity and scope-aware filtering.
- Focused adapter/native-hook, refresh and remote catalog tests; real Composer browser/Electron checks; affected typechecks/build/docs impact.

## handoff
- Complete for the scoped capabilities. Unrelated i18n/theme/restore changes preserved.
- Local DSH now validates user invocation, scoped name/path and loader availability before lowering Skill references to native /name gestures. All prompt-lowering call sites (owned start, normal start, steer and queue add/edit) share the path. Private capability endpoint and packaged mjs resource included.
- Native test invokes the installed dsh-tool-skill pre-step handler and asserts a skill-invocation message with full synthetic instructions. Adapter dispatch tests assert turn/steer send the gesture only after validation; stale/disabled/missing loader fails before RPC.
- Hermes Profile-scoped Composer directory uses catalog plus bounded (4) concurrent content metadata reads, returns canonical paths without bodies and rejects connection replacement. Submit/steer validates enabled name/path; installed-change events also emit skills/changed. Unscoped instance Hosts require Profile selection; old endpoints lacking path report metadata errors, not guessed paths.
- Optional ComposerCatalog change subscription triggers active picker refresh. Host/root/revision cache keys isolate in-flight old responses. Full browse no longer stops at 50; multiword/NFKC/path-separator matching improved. This is not a byte-for-byte port of Codex's proprietary scorer.
- Skill icon HTTPS/raster-data allowlist with no-referrer/fallback; scope, loading, empty/error/retry messages integrated with English/Chinese i18n.
- Verification: 234 DSH tests, 410 chat tests, 175 AppServer tests and extension suite passed in gate; all workspace typechecks/boundaries/i18n gates passed. Full gate then stopped at an unrelated pre-existing sidebar assertion requiring literal return "Sign in" after concurrent i18n migration (workbench-sidebar-dock.test.ts:148); no unrelated patch made. Initial common.retry defaultMessage conflict introduced here was fixed with a Skill-specific id before the successful i18n checks.
- Web and Electron Host builds separately passed after that gate stop; logs /tmp/opencraft-skill-execution-build.log and /tmp/opencraft-skill-execution-gate.log. No distribution App packaged or installed.
- Real ProseMirror Electron smoke passed: 63-item browse, open-list add/remove, held revision races, scoped Host replacement, locale switch retaining draft, original keyboard/mouse/IME and error flows. Final report /var/folders/pc/47xyrxbs1296b6sjfc2sfd6r0000gn/T/opencraft-skill-autocomplete-RhVbb5/report.json; dark screenshot visually reviewed.
- Focused native/remote/search tests passed (16), icon safety passed; diff and docs-impact checks passed. Remote tests use synthetic Dashboard responses; no live remote machine, account or inference request was used. No commit/push or production operation.
