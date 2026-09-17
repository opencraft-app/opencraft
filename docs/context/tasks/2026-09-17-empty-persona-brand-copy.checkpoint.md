## stage
- Implementation and gates complete; user approved the international local preview and authorized MR delivery.

## verified
- `/agents/persona` maps to the `buddy` section, and `/agents` defaults to `channel`.
- Shared header is the direct DOM sibling before the AgentSettingsPage root when authenticated.
- The English copy's existing source key is `k_40a58d40`.
- Focused tests 27/27, `pnpm check` with 0 new diagnostics, global build 649 pages, documentation validator exit 0, `git diff --check` clean.
- The previous dev listener exited after global build. Restarted `pnpm dev:global:proxy` from this worktree; `/agents/persona/` returns HTTP 200 and anonymous `/auth/session/` returns 401 on port 5174. Refreshed Chrome reaches the login gate. No listener exists on 5173, the target in the user's Whistle error screenshot.
- OAuth start through localhost proxy sets a host-only `lc_google_oauth_state` cookie on `127.0.0.1`, while Google's configured callback host is `api.lightvela.ai`; this is incompatible with the required state comparison and explains the repeated `google_state_mismatch`. Previous localhost-login guidance was wrong.

## unverified
- Authenticated visual confirmation of the no-Bot page and the unchanged `/agents` frame. Existing Whistle `lightvela.ai -> 5173` rule and current localhost proxy are not an auth-compatible preview pairing.

## discard
- No unrelated repository-wide scans or temporary authentication workarounds.

## restore
- Worktree `/Users/pablozhong/codex/lightvela-remove-sidebar-buddy-menu`; prior sidebar dropdown edits are user-scoped and must be preserved.
- `pnpm dev:global:proxy` preview runs on port 5174 from this worktree; Chrome local URL is `http://127.0.0.1:5174/agents/persona/`.

## next_action
- Commit the scoped empty-persona change into the UI MR and verify its remote state; keep Soul MR !4154 separate.
