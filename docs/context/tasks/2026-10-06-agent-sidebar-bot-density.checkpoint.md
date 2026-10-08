## stage

Desktop Bot selector sizing is implemented and locally validated; next gate is updating MR !5036.

## verified

- The desktop expanded selector is shorter (48px minimum outlined height) and its Bot name uses 13px type. Mobile and collapsed selectors keep their existing sizing.
- Nav-spacing tests 7/7, one Agent page component test, `pnpm check`, CN/global builds, and `git diff --check` passed.

## unverified

- Authenticated browser pixel review has not been performed for the user's account.
- A separate older multi-Bot test was stopped after stalling; it provides no pass result.

## discard

- The build-generated `frontend/next-env.d.ts` modification was reverted.

## restore

- Worktree: `/Users/pablozhong/.codex/worktrees/mobile-account-menu/lightvela`, branch `codex/mobile-account-menu`.
- This follow-up changes only desktop profile CSS, its adjacent test, and two task records.

## next_action

- Stage the four scoped files, run the staged change-impact gate, commit, push, and verify MR !5036 and immediate CI state.
