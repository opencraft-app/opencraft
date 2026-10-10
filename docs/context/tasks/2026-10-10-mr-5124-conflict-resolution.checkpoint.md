## stage
Conflict resolution staged in isolated worktree; OpenCraft full gate reached an unrelated master-side IM test failure.

## verified
- MR !5124 source `acd8c3418d`, master `3bc4384e53`; merge reproduced 18 conflicts.
- Locale key unions had no differing common values; Thai additions translated and i18n validation passed.
- No unresolved index entries; focused tests 87/87, frontend check and build, generated mirror check, docs and change impact validation passed.

## unverified
- OpenCraft full gate cannot pass: isolated `im-chat-service.test.ts` fails on `2 !== 1`; file is unchanged relative to `origin/master`.
- Remote MR conflict status after a future authorized push.

## discard
- Initial sandbox frontend build stall and OpenCraft install without postinstall; both replaced by successful reruns.

## restore
- Worktree: `/private/tmp/mono2-mr5124-resolution`, branch `codex/mr5124-conflict-resolution`.
- Existing MR source worktree has unrelated uncommitted changes; do not modify it.
- Repo policy requires explicit user confirmation before commit or push.

## next_action
- Wait for full gate, then request approval to commit and push the tested merge resolution to the MR source branch.
