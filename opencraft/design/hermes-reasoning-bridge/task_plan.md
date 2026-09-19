# Hermes reasoning bridge plan

## Goal

On current `origin/master`, remove the unused OpenCraft Agent catalog and make Hermes model reasoning capability, selection, Session state, and request application coherent without changing generated AppServer schema.

## Phases

- [complete] Red tests on current master.
- [complete] Remove `agent/list` extension/query/UI catalog while retaining `turn/start.agentId`.
- [complete] Implement Hermes reasoning catalog and Session lifecycle.
- [complete] Focused tests, UI smoke, full gate, macOS preview.
- [complete] Documentation and handoff.

## Invariants

- `bot/*` exclusively owns product Bot identity; no hidden Agent catalog.
- Empty effort set means no configurable reasoning.
- `none` exists only for models that can disable reasoning.
- GLM 5.3 exposes only `low/high/max`, defaults to `high`, and never sends `none`.
- UI, defaults, compiler, Session creation, active Turn update, and resume consume the same capability.
- Provider wire clamping remains owned by Hermes Runtime.

## Errors

- Initial implementation was completed on a branch 221 commits behind `origin/master`; user identified the stale baseline. That build is invalidated. Reimplementation started in this fresh worktree.
- First parallel verification orchestration had a JavaScript syntax error (missing semicolon after the call array); no test command started. Corrected the orchestrator before retry.
- Parallel focused verification produced one unrelated local-agent process test failure (`posix_spawnp failed`) while Hermes/catalog/reasoning tests passed. Re-run that process suite alone after concurrent typecheck/UI work settles; do not change product code from this signal.
- Current `origin/master` initially failed typecheck because `hermes-diagnostics-management-view.tsx` omitted the already-existing required `execDebugCommandStream`. Added the same account-owned stream port with the established diagnostics timeout; Web, Expo, and plugin typechecks then passed.
- First current-master UI smoke timed out before Composer mounted; added error/body capture and retry after concurrent work settled.
- Captured UI error showed current master removed `ComposerPresentationProvider`; updated the smoke fixture to use the current direct CodexComposer contract.
- Local-agent process failure traced to `npm ci` dropping the executable bit on node-pty's untracked `spawn-helper`; restored that worktree dependency permission, no source change.
- Current-master UI behavior passed, but the smoke's strict console assertion caught Vite's missing favicon 404. Added a 204 fixture route instead of suppressing console errors.
- First full gate reached DSH tests after all typechecks and Hermes suites passed, then failed three checkpoint files because fresh `npm ci` does not populate `runtime/dsh`; run the repository-owned `prepare:dsh-runtime` prerequisite before retry.
