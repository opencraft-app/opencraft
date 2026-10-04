## stage
MR !4951 CI repair after merging current `origin/master`; local validation passed, separate generated commit and push are next.

## verified
- CI and local `check:mono2-agent-console` fail on vendored `i18n/generated/en-US.json` drift.
- Frontend source is committed; the worktree includes current `origin/master` via a merge commit.
- `opencraft/AGENTS.md` and `MONO2_MIGRATION.md` require script-generated output and a separate follow-up commit.
- Official sync changed eight locale dictionaries and `UPSTREAM.json`; the read-only closure check passed. OpenCraft embedded CI tests passed 155/155, plugin typecheck passed, and documentation validation reported no errors, warnings, or broken links.

## unverified
- Remote CI result after the updated MR is pushed.

## discard
- Translation warnings and MDX deprecation notices are not the terminating CI error.

## restore
- MR !4951 uses branch `codex/agent-sidebar-collapse` in the isolated worktree.

## next_action
- Commit the script-generated output separately, push the branch, and inspect the refreshed MR and CI status.
