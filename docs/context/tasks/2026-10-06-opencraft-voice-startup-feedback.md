---
id: opencraft-voice-startup-feedback-20261006
type: task
scope: Accurate, text-free Composer feedback while microphone startup is pending.
triggers: ["opencraft voice startup feedback", "dictation permission wording"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/docs/platform-architecture.md
  - opencraft/packages/codex-composer/src/dictation-footer.tsx
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-05
revision: 1.0.0
precedence: task
derived: false
---

## goal
Show an existing small progress indicator without visual permission wording during voice startup; only confirmed listening presents the waveform.

## non_goals
- No microphone prewarming, capture retention, timing/gesture changes, protocol changes, paid ASR calls or real audio recording.
- No current-preview replacement or restart authorized; user explicitly authorized commit/push/merge on 2026-10-07.

## requirement_refs / requirement_excerpt
User observed ~200 ms labelled 等待系统授权; approved proposed startup spinner and honest ready-state presentation with 好。

## interface_refs / data_structure_refs
Composer transient dictation interaction owns phase/presentation; speech provider owns physical capture readiness and cancellation. Phase starting does not prove permission prompt. Existing progress primitive owns motion and reduced-motion behavior.

## history_context
Current clean baseline master receipt 5d9c122c5. Startup analysis found no fixed 200 ms timer: 150 ms hold threshold, getUserMedia/AudioContext readiness, capability discovery on activation rather than per start. Actual iPhone latency remains unmeasured.

## acceptance
- Held capture startup shows progress but no permission text or waveform; accessible neutral startup announcement remains.
- Cancel and draft replacement fence late readiness, preserve draft and do not submit.
- Readiness replaces progress with waveform in the same Footer geometry; transfer and error states retain existing controls.
- Real Composer browser test desktop/touch × light/dark plus focused component tests and affected types/boundaries.

## affected_paths
Composer dictation Footer, voice action accessible label, existing Hunyuan fixture/smoke, focused tests and corresponding formal design.

## context_receipt
- Root/OpenCraft AGENTS; opencraft-maintenance Skill and verification checklist read for scope/ownership/evidence.
- Router `opencraft dictation footer starting spinner permission wording` matched frontend-product-surface by footer; read required frontend service doc, but no frontend scope is touched.
- Frontend-runtime-openspec-i18n adjacency read; existing voice test/smoke neighbors inspected.
- Platform architecture voice ownership, DIC invariants, exact style/progress definitions, package scripts and change-impact rule inspected.
- Prior no-route query and guessed nonexistent package/test/style paths recorded in ignored analysis note; refined with rg --files instead of broad scans.

## evidence / validation
Analysis-only focused tests passed 4/4. Implementation checks: 30 focused component/provider/gesture/progress tests passed; affected Composer, voice plugin and shared Web progress typechecks passed; platform/typography boundaries and i18n checks passed; own Web build passed (existing chunk warnings). Expanded actual Composer Hunyuan smoke passed desktop/touch × light/dark: held microphone readiness shows only shared progress; neutral announcement, correct disabled/enabled actions, readiness-only waveform, dynamic reduced-motion cancellation, stable Footer bounds/editor DOM, pending cancel/replacement fences, existing final-only insertion/retry/send behavior. Only synthetic Chromium microphone/readiness delivery and local vendor response used; no real microphone or upstream inference. Formal change-impact check passed. New regression is included in test:native-speech, so it runs in gate.

## risks / decisions
The updated standard native-speech test entry passed all 40 tests, and the consuming workbench-web typecheck passed.

Keep authoritative ready event and existing timers untouched. Never claim a shorter OS startup from a presentation-only change. Use neutral accessible wording, no invisible recording to hide delay.

## scan_scope / scan_output
Voice plugin, Composer Footer, existing progress primitives and neighboring tests; no reference sweep or private values.

## handoff
Implementation complete in fix/voice-startup-feedback-20261006. User authorized commit, push and normal merge to master on 2026-10-07; current preview remains unchanged. Actual iPhone timing remains unmeasured; no claim of shorter OS startup. Delivery routing query matched no context pack; existing task evidence and exact affected paths were reviewed. Queue has no corresponding item, so unrelated optimization cards remain untouched.

Delivery verification on master baseline 948b57fe9: no-conflict rebase; standard speech suite 42/42, four affected/consuming typechecks, boundaries/typography, i18n and Web build passed. Changed-file secret/local-link scan passed. No blocking issue found in the bounded pre-submit source review. Platform/owner review and real phone permission/latency acceptance are not replaced by this self-review.
