# Task: Stabilize sidebar leading-control geometry

## Context receipts

- `AGENTS.md`: required the context router, a task pack, adjacency review, and proportionate verification.
- `opencraft/AGENTS.md`: established `opencraft/` as the owned workspace and requires focused tests for shared Workbench UI changes.
- `opencraft/docs/platform-architecture.md`: assigns DOM/SCSS chrome geometry to Workbench Web and semantic tokens to the design system.
- `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md`: reviewed as the nearest frontend adjacency card; no API or i18n surface is changed by this geometry correction.
- `docs/context/tasks/TASK-TEMPLATE.md`: used as the task-pack shape.
- Context router query: `OpenCraft sidebar rail icon alignment and account user attribute button pressed-state text shift`; no route matched, so bounded exact source search was used.

## Problem

Sidebar navigation actions and the account trigger reserve different leading
geometry. A 15px navigation SVG is laid out directly after 8px padding, while
the account trigger reserves a 28px avatar column. The resulting optical axes
differ, and interaction state can make the account control appear to reflow.

## Acceptance criteria

- Primary and footer navigation icons use the same 28px leading slot as the account avatar.
- Icon glyphs remain centered inside that slot independent of hover, selected, or open state.
- Opening the account menu changes paint only; the trigger's grid and text column remain stable.
- Existing sidebar behaviors and accessible labels remain unchanged.

## Intended changes

- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/workbench-sidebar-dock.test.ts`

## Non-goals

- Redesigning the sidebar information architecture.
- Changing icon artwork, account data, menu behavior, or extension contracts.
- Publishing or deploying the result in this task turn.

## Verification

- Focused Workbench sidebar tests.
- Workbench Web TypeScript/build checks if the focused source change passes.
- Context change-impact validation for the final staged diff.

## Production receipt

- Source commit: `20f7dae9b` on `master`.
- Release build: `20260911084149-a287ea5350f7`.
- EdgeOne Makers project: `vela-cn`, production deployment `dp3q8942ydtq`.
- Public verification: `https://chat.lightvela.com/version.json` and the root `opencraft-build-id` meta returned the release build.
- Host verification: `/vela/apps/workbench-web/dist-lightvela-web` was atomically advanced from `20260911073331-a4365858b0f6`; `vela-workbench-web.service` is active and its local version endpoint returns the release build.
