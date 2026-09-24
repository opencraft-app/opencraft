## stage
Ready to commit the isolated iOS Web fix based on current `origin/master`, then push and fast-forward or merge through the repository's required path.

## verified
- The isolated branch contains only this fix's Web metadata, mobile CSS, regression test, design docs and Task Pack.
- Web typecheck, Workbench unit, shell-space, Web-release, boundary and build gates pass in this checkout.
- The deployed test-server preview was separately smoke-tested; actual iPhone WeChat/WeCom behavior remains unverified.

## unverified
- Remote branch acceptance and master merge are pending.
- No physical iPhone embedded-browser result is available.

## discard
- The older feature branch is 230 commits behind current master and has unrelated commits and dirty files; do not merge or push it as this fix.

## restore
- Worktree: task-isolated checkout of the current master base; its machine-local path is not part of this record.
- Branch: `codex/opencraft-ios-webview-zoom-20260924` from the fetched master head.
- The original checkout and its uncommitted changes have not been altered by this isolated branch.

## next_action
- Commit the seven scoped files, push the topic branch, then update master only with that commit and verify remote master.
