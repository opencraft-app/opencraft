## goal
Allow users to mark a historical Agent conversation as unread from its sidebar menu.

## non_goals
- Add an unread field to the SDK or server conversation contract.
- Change existing rename, delete, or session selection behavior.

## requirement_refs
- User request on 2026-10-06: add “Mark as unread” / “标记为未读” between rename and delete.

## interface_refs
- `LightVelaSessionActions` in the installed LightVelaPanel 1.5.24 SDK exposes rename and delete only; `LightVelaSession` has no unread field.
- `sidebarSessionBotKey` scopes the existing list to account, Bot, profile, and site.

## history_context
- `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md` describes the host-rendered session list.
- The preceding local task removed icons from these rows in the same worktree.

## acceptance
- Menu order is rename, mark as unread, delete.
- Marked rows show an unread indicator and accessible unread label.
- Opening the row clears the marker; it survives page remounts and stays isolated by account/Bot.
- The English label is “Mark as unread” and the Chinese label is “标记为未读”.

## affected_paths
- `frontend/src/pages/marketing/agent-sidebar-session-list.ts`
- `frontend/src/pages/marketing/agent-settings-page.tsx`
- `frontend/src/styles.css`
- Sidebar tests and generated locale dictionaries.

## required_context
- `frontend-product-surface`, `service-frontend`, `site-environment-routing`.

## context_receipt
| File | Why read | Use |
|---|---|---|
| `docs/context/project/services/frontend.md@2.1.0` | Frontend boundary | Select checks |
| `docs/context/domains/site-environment-routing.md@2.0.0` | Shared site boundary | Scope marker by site |
| `frontend/AGENTS.md@HEAD` | Service rules | Use i18n and validation commands |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@1.0.0` | Locale and test adjacency | Check generated dictionaries and focused tests |
| `frontend/openspec/changes/2026-08-24-sidebar-chat-settings-tabs-plan.md@HEAD` | Sidebar history | Preserve list behavior |
| `frontend/node_modules/@tencent/agentchat-lightvela-panel/dist/types/sessionController.d.ts@1.5.24` | SDK contract | Keep unread state local |

## evidence
- Focused sidebar tests: 43 passed with temporary `127.0.0.1` Vitest config (host DNS cannot resolve `localhost`).
- `pnpm check`: passed, 0 new TypeScript diagnostics; all six locale dictionaries have translations for both new strings.
- `pnpm build`: passed.
- Documentation validation and `git diff --check`: passed.
- OpenCraft sync check: expected drift in generated locale copies after changing the frontend dictionaries. Its required source commit and later generated-copy commit were not authorized.
- Full frontend tests were attempted earlier in this worktree; unrelated failures and worker heap exhaustion prevented a passing suite.

## risks
- Unread state is browser-local and does not sync between devices.
- Storage can be unavailable; the marker still works until the page unmounts.

## validation
- Focused sidebar tests, `pnpm check`, `pnpm build`, OpenCraft sync check, and change-impact check. OpenCraft sync remains pending the required commit sequence.

## decisions
- Use localStorage keyed by the existing account/Bot/profile/site identity. Keep the marker until the row is explicitly opened.

## handoff
- Local implementation only; no commit, push, MR, or deployment requested. Generated OpenCraft copies must be synchronized after a frontend source commit.
