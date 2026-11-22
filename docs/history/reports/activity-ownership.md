# Activity ownership

2026-09-08. Implemented locally; no deployment is implied.

## Production changes

1. Separate display readiness from final-answer authority. A nonempty unphased
   assistant message can render and suppress Thinking, but cannot claim that
   the final-answer phase has started. Only a displayable `final_answer` does
   that.
   Text display and post-assistant ordering retain their separate predicates.
2. Evaluate disclosure and ownership regions once from raw user choice.
   `resolveAgentActivityLayout(unit, persistedCollapsed)` now owns the complete
   decision. Removed `isAgentActivityCollapsed`; Web and Expo pass the stored
   choice directly. The old flow first normalized the result to “not collapsed”
   when no toggle was shown, then fed that result back into partitioning as if
   the user had chosen to expand. A compaction-only region with persistent
   steering demonstrates why those states are different.
3. Retain Unit identity when a completed single-item group becomes standalone.
   The previous demotion replaced the
   `agent-activity-group:*` key with `agent-activity-standalone:*`. The wrapper
   identity is now preserved; its inner renderer may still legitimately change.

No status-keyed animation, compensating offset, completion delay or global
animation disable was introduced. The previous row-measurement correction
remains in place. This is not an assertion that all reported production motion
had one cause.

## Verification

- 221 focused unit tests passed.
- Web and Expo TypeScript checks passed.
- 12 Activity browser event boundaries passed.
- Five full Conversation work/final/collapse measurement regressions passed.
