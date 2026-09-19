## stage

Complete locally; no commit or external deployment action was performed.

## verified

- The current worktree diverges materially from `origin/codex/chat-demo-v2`, so the requested behavior was ported selectively rather than cherry-picked.
- Skills and Cloud Storage reuse existing Hermes settings contributions and are the only pages promoted to persistent Work navigation.
- `npx tsx --test tests/lightvela-work-navigation.test.ts tests/workbench-sidebar-dock.test.ts` passed.
- Web and LightVela Hermes plugin typechecks passed; `validate_change_impact.py --staged` and `git diff --check` passed.
- Production preview loaded both promoted routes outside the management dialog and showed the expected anonymous sign-in prerequisite.
- Skills now has a direct primary Sidebar entry and asks for a Hermes Host rather than LightVela login; Cloud Storage keeps its cloud-instance boundary.

## unverified

- Connected Host Profile Skills operations are not exercised because this task does not authorize installing, enabling, or disabling user Skills.
- Authenticated cloud storage operations are not exercised because this task does not authorize account or file mutations.

## discard

- Direct cherry-pick of `98d772d06`; its AppShell and sidebar assumptions conflict with current user changes.
- Source branch Whistle configuration, logo asset, and unrelated presentation changes.

## restore

- Task Pack: `docs/context/tasks/2026-09-16-chat-demo-management-navigation.md`.
- No preview or browser session remains running from this task.

## next_action

- Acquire an authorized authenticated Bot session only when populated-panel acceptance is required.
