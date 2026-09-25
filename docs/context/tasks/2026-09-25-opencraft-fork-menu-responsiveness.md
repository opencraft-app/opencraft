---
id: task-opencraft-fork-menu-responsiveness
type: task
scope: Make the Activity menu's new-branch action respond promptly and visibly.
status: implemented-unreleased
---

## goal
Remove avoidable catalog-refresh latency from opening an acknowledged Fork, and show an in-progress state while the Host request is pending.

## non_goals
- Change Host Fork semantics, invent a child before Host acknowledgment, or replace the running preview without a separate request.

## requirement_ids / requirement_refs / requirement_excerpt
- User, 2026-09-25: “好像新建分支也不是很灵敏”.

## interface_refs / data_structure_refs
- `ThreadRowMenu` calls `onFork`; `hostCatalog.threadManagement.fork` is the Host-owned request and returns a child ID.
- `forkAndOpenThread` samples `workbenchNavigation.getSnapshot().routeScopeId` before the request, opens the acknowledged child only if that scope still owns navigation, and refreshes the catalog without awaiting it.
- `workbench-runtime` projects durable blank Forks as unlisted until the first Turn; direct route navigation is therefore independent of catalog refresh.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/design/invariants.md#WSP-12`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: The Activity menu uses the same Host lifecycle capability for Codex and DSH; the preceding implementation awaited `queryClient.invalidateQueries` before navigating and closed the Radix menu without visible pending feedback.
- `superseded_refs`: none.

## acceptance
- Fork is submitted once; pending state is visible on the persistent Activity row menu trigger.
- Successful Host response navigates before a slow catalog refetch completes; failure never opens a child.
- A user navigation to another route scope during the request is not overwritten by a late Fork result.
- Focused tests, Web typecheck, release build, change-impact and diff check pass; live preview status is reported separately.

## affected_paths
- `opencraft/apps/workbench-web/src/app.tsx`
- `opencraft/apps/workbench-web/src/components/thread-management.tsx`
- `opencraft/apps/workbench-web/src/runtime/thread-fork-navigation.ts`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/thread-fork-navigation.test.ts`
- `opencraft/tests/sidebar-activity.test.ts`
- `opencraft/docs/platform-architecture.md`
- `opencraft/design/invariants.md`
- `docs/engineering/domains/agent-gateway-runtime.md`

## required_context
- Router query `OpenCraft thread fork new branch menu click delayed feedback responsiveness Host request navigation` matched the generic frontend-product-surface card; its LightVela frontend scope was ruled out. Bounded OpenCraft source and design search located the actual owner.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md`, `opencraft/AGENTS.md` | repository and service constraints | task/impact and preservation rules |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md`, `references/verification.md` | OpenCraft interaction maintenance | ownership and validation levels |
| `docs/context/project/services/frontend.md` | router result | ruled out LightVela card |
| `opencraft/docs/platform-architecture.md`, `opencraft/design/invariants.md` | Fork contract | acknowledge before navigation and route ownership |
| `opencraft/apps/workbench-web/src/app.tsx`, `components/thread-management.tsx`, `runtime/workbench-navigation.ts` | actual client path | located await and pending feedback gap |
| `opencraft/packages/workbench-runtime/src/appserver-runtime.ts` | runtime projection | direct child route before catalog freshness |

## evidence
- Before change, `onFork` awaited `invalidateQueries` after Host acknowledgment and before `navigate`; active refetches could delay visible child opening.
- The menu closed immediately on selection; its existing `busy` flag had no persistent visible affordance.
- Focused tests cover held refresh, changed route, refresh rejection and Host Fork rejection; 29/29 related tests passed.
- Web TypeScript check and Web release build passed. Change-impact check passed with `agent-gateway-runtime` owner-review advisory; `git diff --check` passed.

## risks
- Background catalog refresh can fail independently; navigation must still open an acknowledged child. The query remains eligible for future refetch.
- A late Host result after route change still exists at the Host; client must not steal the user's current route.
- Live Host and touch feel remain separate from static/unit validation.

## validation
- Run focused tests, Web TypeScript check, release build, change-impact script and `git diff --check`; report any unavailable live browser/Host checks.

## decisions
- Preserve Host acknowledgment as the commit point; remove only the unrelated catalog-refresh wait.
- Keep the Radix menu semantics; display progress on its persistent row trigger and disable repeated clicks while pending.

## scan_scope
- `opencraft/apps/workbench-web/src` Thread menu, navigation and styles; `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`; nearby tests/design docs.

## scan_output
- Bounded source search; no saved artifact.

## handoff
- Source implemented; running preview still points at release `20260925103419-23c1aeeb42e7` and has not been replaced. A live touch/desktop pass remains after an explicitly requested replacement.
