## stage
Local preview and validation complete; user requested updating the existing MR.

## verified
- The left and right divider top edges are both at viewport Y=67px in the local Chrome preview.
- OpenCraft typecheck, shell-space tests (17/17), 130-file sync check, embedded production build, and diff whitespace check passed.
- The 5174 preview and its 10002 iframe source respond with HTTP 200.

## unverified
- The user's own browser zoom and visual judgment after refreshing.

## discard
- The original right divider coordinate of 68px; the current CSS moves it to 67px.

## restore
- Changed style: `opencraft/apps/workbench-web/src/styles/app.scss`.
- Existing Hermes preview overlay files in the worktree belong to the earlier task and are outside this commit.

## next_action
- Commit this scoped fix, push the branch, and confirm the existing MR state.
