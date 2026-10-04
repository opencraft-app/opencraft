## stage
Follow-up implementation and service gates complete; MR handoff pending.

## verified
- MR !4965 merged, and the user's WeChat iOS screenshot still shows only a caret after keyboard focus.
- A focused test reproduces both document scroll and WebKit-style viewport pan, then passes with page-relative sizing and keyboard dismissal.
- A Chromium fixture with the real helper placed the composer bottom at the simulated keyboard edge after page scroll.
- Frontend focused test, check, CN build, OpenCraft generated-copy check, and documentation validation passed.

## unverified
- Physical iPhone WeChat keyboard interaction and production delivery.

## discard
- The earlier test's fixed root-top assumption is insufficient for page movement.

## restore
- Active worktree: `/Users/pablozhong/.codex/worktrees/mobile-chat-keyboard/lightvela`, branch `codex/mobile-chat-wechat-keyboard` from `origin/master` at `09dc4d9a9`.
- Task Pack: `docs/context/tasks/2026-10-04-mobile-chat-wechat-keyboard.md`.

## next_action
- Run the staged change-impact gate, then submit and verify the follow-up MR.
