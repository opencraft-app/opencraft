## goal

Keep the primary OpenCraft Sidebar focused on active work and move archived
conversation browsing/restoration into capability-gated Settings.

## non_goals

- Do not change archive/unarchive persistence, AppServer methods, or Thread identity.
- Do not add deletion or another archived-conversation cache.
- Do not keep a second archive entry or undo surface in the main workbench.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: remove the visible archive confirmation block and move archived conversations from the main interface into Settings.

## interface_refs / data_structure_refs

- `hostCatalog.threadManagement.capabilities(hostId).archive` gates visibility.
- `listArchived(hostId)` and `unarchive(hostId, threadId)` remain the only query/mutation owners.
- Query invalidation stays under `['appserver', hostId, 'threads']`.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md#thread-lifecycle-ownership`.
- `relevant_evolution`: archive persistence and commands already existed; only presentation ownership moved.
- `superseded_refs`: Sidebar archived dialog and transient archive undo banner.

## acceptance

- Main Sidebar contains neither an archived-conversations entry nor archive undo feedback.
- Settings exposes archived conversations only for a Host declaring archive support.
- Restore uses the existing Host command and refreshes the shared Thread catalog.
- Loading, empty, read failure, per-row restore progress and per-row restore error remain visible and accessible.

## affected_paths

- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/components/settings-page.tsx`
- `opencraft/apps/workbench-web/src/components/thread-management.tsx`
- `opencraft/apps/workbench-web/src/styles/context-menu.scss`
- `opencraft/package.json`
- `opencraft/tests/workbench-archived-conversations-settings.test.ts`

## required_context

- No router Pack matched; bounded exact search was used.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft boundaries and gates | Preserve dirty worktree and validate the affected surface. |
| `opencraft/docs/platform-architecture.md` | Thread lifecycle authority | Keep archive state in Host/catalog ownership. |
| `ref/codex` and `ref/wb` archive analysis | Reference behavior | Preserve recoverability while moving management to Settings. |

## evidence

- Exact search found `ArchivedThreadsDialog`, `archivedHostId`, `lastArchived`, `onManageArchived`, and `archiveUndo` entirely in the Web presentation path.
- Existing lifecycle tests already prove durable archive/unarchive behavior independently from the UI.
- Isolated packaged Electron preview visibly showed no archived entry or undo
  block in the main Sidebar, then showed the capability-gated `Archived
  conversations` item and Settings page. The first preview exposed a missing
  empty-state sentence; a red test reproduced it and the final build now renders
  `No archived conversations.` with one Refresh action. The Mac locked before a
  second screenshot of that last copy-only correction, so it is covered by the
  focused source contract and rebuilt artifact rather than claimed as recaptured.

## risks

- Hostless Settings must not invent archive support; the new props default to unavailable.
- Restore errors must stay with the affected row instead of becoming a global notice.

## validation

- `npm exec tsx -- --test tests/workbench-archived-conversations-settings.test.ts tests/workbench-sidebar-dock.test.ts tests/workbench-location.test.ts tests/thread-lifecycle.test.ts`.
- `npm run typecheck --workspace @opencraft/workbench-web`.
- `npm run test:workbench:unit`, `npm run build:web`, context and change-impact gates.
- Completed: focused lifecycle/navigation suite 42/42; Workbench unit 261/261;
  Web typecheck, Web build, Electron build, isolated preview packaging,
  platform boundaries, documentation and bounded change-impact checks passed.

## decisions

- Add one built-in Settings route rather than another extension protocol or modal owner.
- Reuse `SettingsPageHeader`, `SettingsSection`, `SettingsGroup`, `SettingsListItem`, `SettingsNotice`, and `SettingsButton`.
- Use the existing Lucide archive icon; do not add a new icon asset or library.

## scan_scope

- `opencraft/apps/workbench-web/src`, related Workbench tests, lifecycle design, `ref/codex`, and `ref/wb` archive references.

## scan_output

- Bounded search and the referenced prior lifecycle analysis; no broad generated-output scan.

## handoff

- Implementation complete locally. Main Sidebar and Settings ownership were
  verified in an isolated packaged Electron preview; the final empty-state copy
  fix was rebuilt after the Mac locked. Nothing was committed, installed or published.
