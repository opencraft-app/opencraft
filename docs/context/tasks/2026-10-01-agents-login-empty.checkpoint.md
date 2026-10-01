## stage
Local fix complete; commit, push, and MR submission authorized.

## verified
- Production `/agents` is blank in the user's session while `/agents/channels` renders the empty state.
- The two render guards disagree on `isSubscribed` when there are no visible Bots.
- Focused regression and adjacent tests, `pnpm check`, and `pnpm build:cn` passed.

## unverified
- No production deployment or post-deployment validation has occurred.
- The full component test file still needs separate investigation for its Vitest worker heap exhaustion.

## discard
- Initial hypothesis of a failed JavaScript chunk; the hydrated page and route comparison disproved it.

## restore
- Worktree: `/Users/pablozhong/.codex/worktrees/agents-login-blank/lightvela`.
- Changed implementation: `frontend/src/pages/marketing/agent-settings-page.tsx`.
- Regression: `frontend/src/pages/marketing/__tests__/agent-settings-create-intent.test.tsx`.

## next_action
- Submit the reviewed local fix as an MR targeting `master`, then verify remote SHA and MR status.
