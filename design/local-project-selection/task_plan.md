# Local project folder selection

## Goal
Native local directory selection with OpenCraft-owned durable projects; DSH consumes execution paths only.

## Phases
1. Inspect contracts and record ownership — complete.
2. Implement durable Host project catalog and narrow Electron picker port — complete.
3. Connect shared project menu with async identity fencing; retain remote picker — complete.
4. Test persistence, cancellation, duplicate selection and real desktop entry; run gate — complete.

## Handoff
OpenCraft final gate and signed Electron automated smoke passed. Final preview CDP 19824 shows enabled Add project menu. Real native dialog opened; physical cancel-click unverified because CUA unavailable. Remote/Web model tests retained, interactive E2E not performed. Repository context checks report existing task-schema/budget/scan issues; this task's schema errors corrected. No commit/push.

## Non-goals
No model/default changes, remote native dialogs, production writes or Git submission.

## Errors
- Context route has no matching pack; bounded exact source search used.
- No agent-gateway adjacency card exists; inspected frontend-runtime card and service test neighbor instead.
- Desktop smoke assumed a visible Chat application button; initial wait failed. Inspect actual initial renderer and use New chat entry instead.
- Native CUA app lookup timed out; no native dialog acceptance evidence yet.
- Actual desktop diagnostic: macOS AF_UNIX path limit rejects long tmpdir/profile daemon socket (EINVAL). Use a short isolated /tmp/oc-picker profile; no product code workaround.
- Automated selection wait timed out; add dialog-call and renderer diagnostics to distinguish mock timing from epoch invalidation before changing product behavior.
- Diagnostics showed correct dialog results, but AppServer transport not open. Disable Add project until Host ready (with explanation), and wait for actual ready status in desktop acceptance.
- Corrected desktop test root selector to existing .app-shell-root; no product behavior change.
- Packaging hooks resolve from Electron project cwd; rerun there rather than with --projectDir from npm workspace root.
