---
id: agent-bot-rail-client-navigation-checkpoint
type: task
scope: Recovery checkpoint for the Bot rail client navigation follow-up.
triggers: ["agent bot rail checkpoint", "bot switch recovery", "session catalog handoff"]
owner: pablozhong
authority: derived
source_of_truth:
  - docs/context/tasks/2026-10-09-agent-bot-rail-client-navigation.md
status: candidate
reviewed_at: 2026-10-09
review_due: 2026-11-09
revision: 1.0.0
precedence: task
derived: true
---

## stage
MR !5117 is open. Review fixes are validated locally; update the existing MR branch and recheck remote status.

## verified
- Inactive Bot anchors previously followed native navigation after their click handler.
- Normal clicks now prevent native navigation and invoke the existing client route switch; direct links and modified clicks remain native.
- Focused tests, `pnpm check`, CN build, and global build pass.
- A pending Thread catalog previously reported an unconfirmed empty list as settled before Host readiness. The bridge now reports loading until the initial query resolves, and the sidebar keeps loading text visually hidden while retaining a screen-reader status.
- Follow-up checks: 48 frontend tests, 600 OpenCraft chat tests, frontend check and CN build, OpenCraft typecheck and embedded build, sync and docs-impact checks all passed.
- `http://127.0.0.1:5174/agents/chat/` serves the current page and rebuilt embedded script.
- User reviewed the 5174 preview and said the interaction looks okay. Gongfeng authentication succeeded; latest `origin/master` is `5c0e1dc83`, whose changed files do not overlap this task.
- CR follow-up: Host error no longer reports perpetual catalog loading; both rail `onSelect` sites, immediate active Bot update, hidden loading row, pending bridge state, and modified clicks have targeted regression checks. CN/global focused tests each passed 41/41; OpenCraft embedded tests passed 221/221; frontend check, OpenCraft typecheck/build, sync check, and documentation validation passed.

## unverified
- No agent-run authenticated Bot-switch browser test; the in-app preview remains at the login gate. Production remains on its deployed version until separately released.

## discard
- Full document reload as the default Bot-switch path; treating pre-query empty catalog as confirmed empty.

## restore
- Worktree `/Users/pablozhong/.codex/worktrees/agents-bot-switch-firstload/lightvela`, branch `codex/agents-bot-switch-client-nav` based on `c72e37f45`; latest fetched `origin/master` is `5c0e1dc83` with disjoint changes.

## next_action
- Run focused frontend/OpenCraft tests and context checks, then update the existing MR branch and verify remote state.
