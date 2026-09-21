---
id: checkpoint-account-return-agents
type: task
scope: Account return navigation handoff
triggers: ["account return agents checkpoint", "billing return handoff", "account navigation recovery"]
owner: pablozhong
authority: primary
source_of_truth: ["docs/context/tasks/2026-09-20-account-return-agents.md"]
status: active
reviewed_at: 2026-09-20
review_due: 2026-12-20
revision: 1.0.0
precedence: task
derived: false
---

## stage
User authorized appending account navigation changes to MR !4321. Local commit rebased cleanly onto source commit a5753241a; combined frontend validation passed and previews restored. Ready for non-force push and remote verification.

## requirement_ids / requirement_refs / requirement_excerpt
2026-09-20 user feedback and final acceptance are recorded in `2026-09-20-account-return-agents.md`: avatar-left return action, compact desktop height, hidden language switcher, localized My Agents menu.

## interface_refs / data_structure_refs
`AccountPage`, `ProductReturnHomeHeader`, `PublicSiteHeader`, `AGENTS_HOME_PATH`; no API or domain-contract changes.

## context_receipt / history_context
- current_design_refs: `frontend/DESIGN.md`; frontend service instructions and site-environment pack were read as recorded in the main Task Pack.
- relevant_evolution: MR !4310 split account pages; MR !4321 already contains upgrade-page polish, retained unchanged by this append.
- superseded_refs: title-adjacent and logo-adjacent layouts are superseded by avatar-left placement.

## verified
- Combined source: 128 tests across seven files passed; `pnpm check` has zero new diagnostics and complete 2942-entry translations.
- Final size: browser measured desktop 36px and narrow-screen 44px on both account routes. Eight CN/global desktop/mobile navigation cases passed before the size-only follow-up; language control remains hidden.
- Latest account-only CN build passed with 104 pages; combined global build passed with 650 pages and 42 SEO route checks.
- Documentation validator and scoped change-impact check passed. Context-audit unit tests: 33 passed. Repository-wide context validation reports 1826 existing findings (matching the MR worktree), none in these two added task files; context contract suite has four baseline failures.

## unverified
- Full frontend suite and production authenticated behavior not checked; no merge or release authorized.

## discard
- Initial localhost DNS failure was bypassed with transient `--api.host 127.0.0.1`; no repository configuration changed.
- Run check and build serially; stop same-worktree dev servers before build to avoid generated-cache collisions.

## restore
- Worktree: `/Users/pablozhong/codex/lightvela-account-plans-billing`, local branch `codex/account-return-agents`; push target is existing MR source `codex/upgrade-plan-polish`.
- Previews use CN 5176 and global 5177 with mock API and local preview auth, not production credentials. User's primary checkout remains untouched.

## next_action
Finish combined validation, push the append to MR !4321 without force, update its description and verify remote SHA and CI state.
