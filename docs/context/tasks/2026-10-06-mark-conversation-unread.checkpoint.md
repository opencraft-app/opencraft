## stage
Local implementation and focused validation complete; ready for handoff.

## verified
- Menu order is rename, mark as unread, delete; opening the row clears its browser-local marker.
- Markers persist across remounts and are isolated by account/Bot key in the focused test (43 tests passed).
- `pnpm check`, `pnpm build`, documentation validation, and diff check passed.

## unverified
- Signed-in browser appearance and cross-device synchronization; SDK has no unread contract.
- Full frontend test suite did not pass due unrelated failures and worker OOM.
- OpenCraft generated-copy check fails on the new locale dictionaries until the required two-commit sync workflow runs.

## discard
- Temporary Vitest config using 127.0.0.1 to work around host DNS.

## restore
- Worktree: `/Users/pablozhong/.codex/worktrees/remove-sidebar-chat-icons/lightvela`.
- The prior icon-removal change remains in this worktree.

## next_action
- Handoff the local diff and the pending OpenCraft sync gate; commit, push, or MR only after explicit user confirmation.
