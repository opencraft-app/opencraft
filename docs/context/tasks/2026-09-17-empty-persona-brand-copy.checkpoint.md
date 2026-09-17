## stage
- MR !4166 CR follow-up: the independent clean worktree submitted the first closure fix as `9b4d9b89d`. After !4154 merged into master, the branch is combining the latest master and regenerating the shared closure; MR merge and release remain out of scope.

## verified
- `/agents/persona` maps to the `buddy` section, and `/agents` defaults to `channel`.
- Shared header is the direct DOM sibling before the AgentSettingsPage root when authenticated.
- The English copy's existing source key is `k_40a58d40`.
- Focused tests 27/27, `pnpm check` with 0 new diagnostics, global build 649 pages, documentation validator exit 0, `git diff --check` clean.
- The previous dev listener exited after global build. Restarted `pnpm dev:global:proxy` from this worktree; `/agents/persona/` returns HTTP 200 and anonymous `/auth/session/` returns 401 on port 5174. Refreshed Chrome reaches the login gate. No listener exists on 5173, the target in the user's Whistle error screenshot.
- OAuth start through localhost proxy sets a host-only `lc_google_oauth_state` cookie on `127.0.0.1`, while Google's configured callback host is `api.lightvela.ai`; this is incompatible with the required state comparison and explains the repeated `google_state_mismatch`. Previous localhost-login guidance was wrong.
- The CR finding was reproduced: `check:mono2-agent-console` failed before generation (`domain/credit-pack.ts` first), and the vendored English prompt still said “Create your cloud AI partner now”. After `sync:mono2-agent-console`, all 129 files passed the closure check; source and copy both say “Create your own AI companion”.
- At the first CR correction, fetched `origin/master` was `1782bebc1` and !4154 was still open. After the first !4166 push, !4154 merged as `5fb403d0a`, and the MR became unmergeable on its generated dictionary and manifest. The latest master was brought into this isolated worktree; the dirty 5174 preview worktree remains untouched.
- Combined `frontend/src/i18n/generated/en-US.json` retains both “Create your own AI companion” and the Soul terminology from !4154. Regenerating the OpenCraft closure resolved all generated-file conflicts; 129-file closure check passes before the merge commit.
- OpenCraft boundary check, all workspace typechecks, extension tests (153/153 plus collaboration 56/56), and Web build passed. Full `npm --prefix opencraft run gate` stopped at `test:appserver`: 152/153 passed; the process-RPC WebSocket replacement test alone failed with `posix_spawnp failed` and failed the same way in isolation. The test and implementation were not changed by this MR.
- Staged change-impact validation and documentation validation passed; generated changes are limited to the 129-file closure and its mapped runtime design note.

## unverified
- Authenticated visual confirmation of the no-Bot page and the unchanged `/agents` frame. Existing Whistle `lightvela.ai -> 5173` rule and current localhost proxy are not an auth-compatible preview pairing.
- The remaining OpenCraft gate stages after `test:appserver` did not run because that stage failed; the Web build was run separately and passed. The combined-source merge still needs post-commit regeneration and validation.

## discard
- No unrelated repository-wide scans or temporary authentication workarounds.

## restore
- Worktree `/Users/pablozhong/codex/lightvela-remove-sidebar-buddy-menu`; prior sidebar dropdown edits are user-scoped and must be preserved.
- Clean CR worktree `/Users/pablozhong/codex/lightvela-mr4166-vendoring-fix` on local branch `codex/mr4166-vendoring-fix`; the preview worktree above remains untouched.
- The earlier `pnpm dev:global:proxy` preview runs on port 5174 from the original UI worktree, not this isolated CR worktree; Chrome local URL is `http://127.0.0.1:5174/agents/persona/`.

## next_action
- Finish and commit the master integration, regenerate and commit the closure at the resulting source revision, run focused checks, push to !4166, and re-query MR status. Do not merge the MR or release.
