# Activity ownership alignment — r3562

2026-09-08. Implemented locally; no deployment is implied.

## Production changes

1. Separate display readiness from final-answer authority. A nonempty unphased
   assistant message can render and suppress Thinking, but cannot claim that
   the final-answer phase has started. Only a displayable `final_answer` does
   that, matching `hasDisplayableContent` / `isFinalAnswerPhase` in r3562.
   Text display and post-assistant ordering retain their separate predicates.
2. Evaluate disclosure and ownership regions once from raw user choice.
   `resolveAgentActivityLayout(unit, persistedCollapsed)` now owns the complete
   decision. Removed `isAgentActivityCollapsed`; Web and Expo pass the stored
   choice directly. The old flow first normalized the result to “not collapsed”
   when no toggle was shown, then fed that result back into partitioning as if
   the user had chosen to expand. A compaction-only region with persistent
   steering demonstrates why those states are different.
3. Retain Unit identity when a completed single-item group becomes standalone.
   Original `je` preserves `e.key`. The previous Vela demotion replaced the
   `agent-activity-group:*` key with `agent-activity-standalone:*`. The wrapper
   identity is now preserved; its inner renderer may still legitimately change.

No status-keyed animation, compensating offset, completion delay or global
animation disable was introduced. The previous row-measurement correction
remains in place. This is not an assertion that all reported production motion
had one cause.

## Original-function verification

`scripts/lib/codex-activity-reference.ts` extracts exact function bodies and
records SHA-256 fingerprints from the supplied r3562 tree. It does not restore
or replace the production source with a second bundled implementation.

- `tests/codex-activity-model.test.ts` executes original `DA`, `TA`, `fA`, `pA`
  and counting logic for 192 combinations of partition shape, final readiness,
  force-expanded, disable-collapse, prevent-auto-collapse and user choice.
  It also checks original `je` identity and final-phase readiness.
- `scripts/compare-codex-activity-rendering.ts` actually renders original
  `DA`, `_A`, `gA`, `ak`, `ok` and spacers beside the production Activity.
  It checks 12 event boundaries, including unphased text, explicit final,
  growth, completion, expansion/collapse and final text before the final clock.
  Every growth/completion sample asserts stable status-node identity and text
  position; all event endpoints compare geometry and toggle state.

The clock-late case is the precise label-only transition: both sides show
`Working for 41s` in the header, then `Worked for 41s` on the **same node**, at
the **same text position**. The first final-phase event can instead migrate a
standalone divider into the header on both sides. In this controlled font
environment both show a 1px local text-position change from that migration.
No change was made to conceal a source-equivalent layout difference.

## Scope of the comparison

The browser reference uses the original outer Activity/disclosure/status
renderers, but shares already-classified Unit inputs, theme metrics and
non-work body rendering ports. Clock text is held at 41s for deterministic
geometry; duration calculation has a separate original-function test. The
fixture supplies the CSS utilities used by these functions, not the entire
installed app stylesheet. Final readiness is evaluated independently from raw
fixture items by the original function, not copied from the candidate verdict.

This closes the earlier “both sides use Vela Activity” verification gap for
these boundaries. It is **not** full installed-app, provider-translator or
all-tool-renderer pixel parity, nor a capture of the user's live event stream.

## Verification

- 221 focused unit tests passed (including the 192 original-decision cases).
- Web and Expo TypeScript checks passed.
- 12 original Activity browser event boundaries passed.
- Five full Conversation work/final/collapse measurement regressions passed.
