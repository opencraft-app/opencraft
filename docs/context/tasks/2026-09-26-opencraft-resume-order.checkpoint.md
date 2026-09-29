## stage
Implementation, focused verification, documentation checks and final diff review complete; handoff remains.

## verified
- Same-View reconnect now reconciles Item order from AppServer history, then replays buffered notifications.
- Full versus partial history membership is handled separately; stale in-progress history cannot regress a completed Turn.
- AppServer 232/232 and Chat/Lab/session 479/479 suites passed; package, runtime, Web and Expo typechecks passed; platform boundary and documentation impact passed.
- Documentation validator and `git diff --check` passed.

## unverified
- Physical mobile lock-screen/reconnect and a newly built running Web client were not exercised.
- Full `npm run gate` was unavailable because no `npm` executable is installed; relevant checks were run directly through the available Node binary.
- Current running service still uses its prior build; no replacement was requested in this turn.

## discard
- The earlier missing-final hypothesis was disproven by the screenshot and backend rollout order; the confirmed source defect is ordered-history reconciliation.

## restore
- Changes are limited to `opencraft/packages/appserver-session/src/merge-turns.ts`, `resume-coordinator.ts`, `opencraft/tests/appserver-session.test.ts`, this task pack and a small mapped formal design addition.
- Preserve all unrelated dirty worktree changes.

## next_action
- Report source-only completion and remaining live validation; do not claim the running service has been replaced.
