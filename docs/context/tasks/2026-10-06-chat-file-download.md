## goal
Allow users to download files generated in LightVela Chat from a file link's right-click menu.

## non_goals
- Change file creation, cloud storage navigation, or publish the change.

## requirement_ids / requirement_refs / requirement_excerpt
- User request, 2026-10-06: add download in the conversation UI on right click; use cloud storage download as reference.

## interface_refs / data_structure_refs
- `opencraft/packages/chat-render-web/src/renderers/resource-link/resource-link.tsx`: rendered file links expose `data-chat-resource-kind` and a resolved `href`.
- `frontend/src/lib/tencent-tssh-file-client.ts`: TSSH `fileInfo` and streamed file reads.
- `frontend/public/tat-hermes-web-proxy-sw.js`: browser download stream protocol.

## history_context
- `current_design_refs`: `opencraft/docs/chat-ui-architecture.md`, `frontend/src/components/domain/tat-file-manager-panel.tsx`.
- `relevant_evolution`: Current Chat is an OpenCraft custom element with an open Shadow DOM.
- `superseded_refs`: none.

## acceptance
- Right-clicking a Chat file link or a plain generated path in a message offers Download, and selection saves the remote file with its basename.
- Hovering a generated file link or plain path shows a dashed underline directly beneath the file path; moving away removes it.
- Download status toasts appear at the top center of the page.
- Other links keep their current context menus. Only paths inside `/home/agentuser` can be requested.
- Directory, oversized, unreadable, missing, and disconnected files report an error.
- Focused component tests and frontend lint/type/test/build gates are run.

## affected_paths
- `frontend/src/pages/marketing/` Chat integration and focused tests.

## required_context
- The follow-up router matched frontend product, service, and site routing packs.

## context_receipt
| File | 阅读原因 | 用途 |
|---|---|---|
| `frontend/AGENTS.md@HEAD` | service boundary and gates | validation |
| `docs/context/project/services/frontend.md@HEAD` | frontend service pack | validation |
| `docs/context/domains/site-environment-routing.md@HEAD` | site routing pack | preview boundary |
| `opencraft/AGENTS.md@HEAD` | embedded Chat ownership | integration boundary |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | frontend neighbor | test selection |
| `opencraft/docs/chat-ui-architecture.md@HEAD` | Chat resource semantics | file link scope |
| `frontend/src/components/domain/tat-file-manager-panel.tsx@HEAD` | existing cloud storage download | protocol and permissions |

## evidence
- Router queries returned no matching pack; bounded exact searches located the OpenCraft file-link renderer and TSSH file manager.
- `pnpm exec vitest run` for Chat download and embedded Chat: 20 tests passed (using a temporary local test config to bind 127.0.0.1 because this host cannot resolve `localhost`).
- `pnpm typecheck`: 0 new diagnostics against the repository baseline.
- `pnpm i18n:check`: passed; `pnpm build`: passed.
- `validate_documentation.py`: no errors or broken links.
- Full frontend Vitest run was interrupted after unrelated model-config tests reported 84 failures; focused tests passed.
- 2026-10-07: fetched `origin/master` and fast-forwarded this worktree from `5b9f70ea2` to `4620dff30` (17 commits). The local Chat integration patch reapplied cleanly; no Git conflict.
- On the refreshed base, Chat download, embedded Chat and cloud storage tests passed (53 tests), `pnpm typecheck` reported 0 new diagnostics, and `pnpm build` passed.
- 2026-10-07 follow-up: Chrome showed the generated `/home/agentuser/...md` as bold text, without an anchor. Added pointer-specific recognition across text nodes in Chat messages; the new focused test failed before the change and passed after it.
- Follow-up `pnpm check` passed with 0 new TypeScript diagnostics, 23 focused Chat/download tests passed, `pnpm build` passed, and the 5174 domestic preview was restarted from this worktree.
- In the authenticated Chrome preview, right-clicking the exact plain path displayed the Download menu. Clicking through to a completed file transfer was interrupted when the user switched Chrome tabs, so transfer completion remains unverified.
- 2026-10-07 hover follow-up: added path-bounded dashed underline for file links and plain paths. The new component interaction test failed before the change and passed afterward; 23 focused Chat/download tests, `pnpm check` (0 new diagnostics), `pnpm build`, and `git diff --check` passed.
- Authenticated Chrome preview at port 5174 showed the dashed underline under the exact generated Markdown path. Evidence: `/Users/pablozhong/.codex/visualizations/2026/10/06/01a1115b-7a5c-7fb3-8ac6-6e3762890f47/chat-file-hover-underline.jpg`; listener PID 51781 has cwd in this worktree's `frontend`.
- 2026-10-07 toast placement follow-up: moved the shared download status toast from the bottom of the Chat pane to the top center of the viewport. `pnpm check` passed with 0 new diagnostics, 7 focused download tests passed, and authenticated Chrome showed `准备下载...` at the top. Evidence: `/Users/pablozhong/.codex/visualizations/2026/10/06/01a1115b-7a5c-7fb3-8ac6-6e3762890f47/chat-file-toast-top.jpg`.
- Before MR submission, `npm --prefix opencraft run check:mono2-agent-console` and the final `pnpm build` passed. The user's authenticated Chrome screenshot displayed `下载完成。` after selecting the file; the saved file itself was not inspected on disk.

## risks
- The browser reported a completed download, but the saved file was not inspected on disk. International Chat was not browser-tested.

## validation
- Focused tests, typecheck, i18n check, build, documentation validation and staged change-impact check.
- `pnpm lint` is unavailable because the current frontend package has no lint script.

## decisions
- Keep the feature in the LightVela embedded Chat host because TSSH credentials and Bot identity belong to that host.

## scan_scope
- `frontend/src/pages/marketing/`, `frontend/src/components/domain/`, `opencraft/packages/chat-render-web/src/renderers/resource-link/`.

## scan_output
- Bounded `rg` output was inspected directly.

## handoff
- The isolated worktree is based on `master` revision `4620dff30`. Source, tests, and local preview are ready for MR submission; merge and deployment remain outside this task.
