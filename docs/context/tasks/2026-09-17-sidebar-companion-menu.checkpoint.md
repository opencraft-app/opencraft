## stage
Scoped component and test changes made; local validation complete; international preview approved. User authorized MR delivery.

## verified
- Dirty primary checkout was left untouched; this worktree started at `origin/master` commit `3165aca5a`.
- The Agent desktop sidebar uses `variant="sidebar"`; the account page top-right menu uses the default header variant.
- Before the implementation change, both new regional assertions failed on the unwanted sidebar link.
- After the change, focused Vitest passed 3 files / 36 tests. `pnpm check` passed with 0 new TypeScript diagnostics; `pnpm build:cn` and `pnpm build:global` passed; documentation validation reported no errors or warnings.
- `pnpm dev:global:proxy` is serving this worktree at `http://127.0.0.1:5174/agents/channels/`; the route returns HTTP 200, and unauthenticated same-origin `/auth/session/` returns HTTP 401. The browser visibly renders the login gate without an error overlay.
- Personal reusable skill `/Users/pablozhong/.codex/skills/lightvela-local-preview/SKILL.md` passed the skill-creator validator.
- User's later screenshot at `https://lightvela.ai/agents/` shows “My AI Companion”; browser inspection confirmed it loads a versioned `__releases/20260917010011-ba49d2802f5e-global` static asset, not the uncommitted local worktree. The local `UserAvatarMenu variant="sidebar"` still guards out the link, while its default header variant retains it.

## unverified
- The signed-in sidebar dropdown has not been visually inspected from this local worktree: the localhost OAuth flow is incompatible with the API callback host. The focused component tests cover the menu behavior in both regions.
- No remote branch, MR, CI, merge, release, or production state was changed or verified.

## discard
- No translation or route changes are needed for this menu-only request.
- Build-generated `next-env.d.ts` and font-subset changes are unrelated to the requested behavior and were removed from the handoff diff.
- Direct `pnpm dev:global` against localhost caused cross-origin auth hydration failure; the existing same-origin proxy script was used instead. For authenticated preview, use the production hostname mapped to local frontend 5174 with direct API, after user approval to adjust Whistle.

## restore
- Worktree: `/Users/pablozhong/codex/lightvela-remove-sidebar-buddy-menu`.
- Main implementation: `frontend/src/components/site/user-avatar-menu.tsx`; regression test: `frontend/src/components/site/__tests__/user-avatar-menu.test.tsx`.

## next_action
Commit scoped UI changes without the Soul overlay, open an MR, and verify its remote SHA and CI state. Existing Soul MR !4154 remains separate.
