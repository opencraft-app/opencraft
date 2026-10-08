---
id: opencraft-voice-startup-feedback-checkpoint-20261006
type: task
scope: Recovery state for startup feedback presentation change.
triggers: ["opencraft voice startup checkpoint"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - docs/context/tasks/2026-10-06-opencraft-voice-startup-feedback.md
status: retired
reviewed_at: 2026-10-06
review_due: 2026-11-05
revision: 1.0.0
precedence: task
derived: false
---

## stage
Implementation and scoped verification complete; no deployment or Git delivery.

## verified
- Starting is broad device/provider readiness, not a proven permission request.
- Capture/recognition/Composer owners and 150 ms hold threshold stay unchanged.
- Existing real Composer Hunyuan smoke covers desktop/touch, light/dark and cancellation, including held-start assertions.
- Held-start assertions now pass: progress without visual prose/waveform, neutral announcement, disabled stop/send and active cancel; readiness swaps in waveform without Footer/editor geometry/identity changes.
- Pending cancel/draft replacement releases late capture; no late UI/text/send. Dynamic reduced-motion change cancels spinner animation.
- 30 focused tests, three affected typechecks, boundaries/typography, i18n, Web build and real Composer smoke passed. Formal design-impact check passed.
- New component regression added to normal native-speech/gate test entry.
- Updated standard native-speech entry passed all 40 tests; consuming workbench-web typecheck passed.

## unverified
Real phone latency is not measured. No current-preview replacement/restart or paid API use authorized. Commit/push/merge authorized on 2026-10-07.

## discard
Guessed codex-composer style/index paths do not exist; rg --files identified app.scss and design-system progress stylesheet. No new parallel spinner system needed.

## restore
Task Pack, ignored voice-startup-analysis.md and source checkout at clean 5d9c122c5, local fix branch. Live preview remains previous committed build.

## next_action
Submit the verified local change via normal master MR policy; preview remains unchanged until separately authorized.
