## goal

Make local DSH conversation restore bounded and truthful: honor the existing
`thread/resume` tail-history contract, guarantee every native RPC retains its
transport deadline, and project native Thread status without inventing review
attention.

## non_goals

- Do not alter the shared AppServer protocol or DSH's durable event storage.
- Do not migrate, delete, or modify user session data.
- Do not change Hermes bridge behavior.
- Do not add another history cache, timeout owner, or renderer recovery state machine.

## requirement_ids / requirement_refs / requirement_excerpt

- User request: migrate DSH to the Hermes bridge's resume/pagination semantics instead of inventing a new path.

## interface_refs / data_structure_refs

- `opencraft/packages/appserver-protocol/src/resume-history.ts`: `initialTurnsPage` is a `ThreadTurnsPageRequest`, and `thread/resume` returns an optional page plus cursors.
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts`: reference behavior for embedded, initial-page, and cursor-only restore paths.
- Invariant: `excludeTurns` suppresses only embedded `thread.turns`; it must not suppress both first-page and cursor-based history restoration.
- `opencraft/apps/local-agent-host/src/dsh-client.ts`: caller cancellation and
  per-request transport deadline are composed; neither replaces the other.
- `opencraft/packages/appserver-protocol/src/generated/v2/ThreadStatus.ts`:
  native status authority is `notLoaded | idle | systemError | active`.
- Invariant: `DshRoutedClient` owns bounded history windows and coalescing;
  `ThreadLifecycle` owns serialization only; Workbench and Sidebar only project
  already-defined states.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/dsh-appserver-boundaries.md`.
- `relevant_evolution`: current DSH adapter incorrectly accepts only boolean `initialTurnsPage`; session runtime sends an object request.
- `superseded_refs`: none.

## acceptance

- Object-form `initialTurnsPage` returns the requested newest page and an older-page cursor.
- Cursor-only resume with `excludeTurns: true` returns a usable cursor for the newest page.
- Existing full `thread/read`, turn paging, and item paging regressions pass.
- A stalled RPC times out even when the adapter supplies a long-lived signal,
  without aborting that caller-owned signal.
- `notLoaded` and `idle` have no activity dot, `active` is running, and
  `systemError` is an explicit semantic error rather than running/review.

## affected_paths

- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/apps/local-agent-host/src/dsh-client.ts`
- `opencraft/apps/local-agent-host/src/dsh-routed-client.ts`
- `opencraft/packages/workbench-runtime/src/models.ts`
- `opencraft/packages/workbench-runtime/src/thread-catalog.ts`
- `opencraft/apps/workbench-web/src/components/sidebar.tsx`
- `opencraft/apps/workbench-web/src/styles/app.scss`
- `opencraft/tests/dsh-history-pages.test.ts`
- `opencraft/tests/dsh-supervisor.test.ts`
- `opencraft/tests/chat-thread-catalog.test.ts`

## required_context

- No router Pack matched; bounded exact source search was used.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft ownership and validation | Limits work to the local Host adapter. |
| `opencraft/docs/dsh-appserver-boundaries.md` | DSH history ownership | Preserve native-event authority. |
| `opencraft/packages/appserver-protocol/src/resume-history.ts` | Protocol authority | Preserve object request and pagination semantics. |
| `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts` | Requested behavior reference | Mirror its three resume-history paths. |
| `opencraft/packages/appserver-protocol/src/generated/v2/ThreadStatus.ts` | Generated status authority | Keep loading, execution and failure meanings distinct. |
| `opencraft/apps/local-agent-host/src/dsh-client.ts` | Native request boundary | Put the finite HTTP deadline at the lowest owner. |

## evidence

- Live DSH contained raw history and the DSH adapter could project 17 turns / 77 items, but object-form tail resume returned no embedded turns, initial page, or cursor.
- After the patch, a read-only real-DSH adapter probe returned 5 initial Turns and older-page cursors for the object-form resume request.
- The installed app's DSH remained healthy and returned the affected native
  history in 31ms, while installed AppHost `thread/turns/list` exceeded 10s.
  The installed bundle still contained the removed full-history index; current
  source projected the same five-turn window in 553ms.
- A synthetic stalled localhost server proved that an adapter lifetime signal
  previously disabled the 30ms `DshClient` deadline. The regression test failed
  at 150ms before the fix and completed by deadline afterward.
- The generated AppServer status union and Sidebar projection proved that
  `notLoaded` was incorrectly shown as `Ready for review` and `systemError` was
  incorrectly shown as running.

## risks

- Cursor direction mismatch could duplicate or skip the newest turn; cover object-page and cursor-only branches in focused tests.
- A shared history flight could otherwise remain pending forever; keep the
  timeout at `DshClient` so all callers and coalesced requests receive the same
  terminal result.
- Do not infer review attention from loading state. Preserve the existing
  `review` presentation for future real attention sources.

## validation

- `npx tsx --test tests/dsh-history-pages.test.ts` (6 passed).
- `npm run test:dsh-bridge` (221 passed).
- `npm run test:workbench:unit` (259 passed).
- `npm exec tsx -- --test tests/dsh-supervisor.test.ts tests/chat-thread-catalog.test.ts` (8 passed after both new regressions failed before implementation).
- `npm run typecheck` (passed; no workspace emitted an error).
- `npm run check:boundaries` (passed).
- `npm run build:web` and `npm run build:electron` (passed; only existing bundle-size and ineffective-dynamic-import warnings).
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` (passed).
- Bounded `validate_change_impact.py --changed-file ...` (passed; `agent-gateway-runtime` owner review remains an MR concern).
- `git diff --check` for the task files (passed).
- Follow-up installation authorization: fresh release build
  `20260917125220-32117fe25346`; Developer ID deep/strict verification passed,
  packaged Renderer/Daemon/DSH engine matched the build, and the signed app
  started with an isolated profile. Gatekeeper assessment remains
  `Unnotarized Developer ID` and is not reported as notarized.
- `/Applications/OpenCraft.app` was replaced with that verified build and the
  previous app was retained at
  `opencraft/apps/workbench-electron/release/install-20260917-1225/previous-OpenCraft.app`.
  The installed executable and daemon run from `/Applications/OpenCraft.app`;
  Local reached Connected.
- Installed-app UI validation opened Thread
  `1787a3a0-0a3a-461c-be95-56ea9d5bf4cb`: bounded history navigation appeared
  and restore left the loading state, then reported the separate runtime error
  `DSH registered 0 of 4 dynamic tools`. Full conversation recovery is therefore
  not yet accepted.

## decisions

- Reuse the existing opaque projection cursor helper; do not introduce a DSH-specific cursor format.
- Compose caller cancellation with the transport deadline in `DshClient`;
  neither adapter nor lifecycle receives a duplicate timer.
- Extend the existing Workbench status union with `error`; do not encode native
  failure as running or overload `review`.
- Reuse design-system status tokens for review and error dots; do not add local colors.

## scan_scope

- `opencraft/apps/local-agent-host/src`, `opencraft/packages/appserver-protocol`, `opencraft/packages/appserver-session`, and the Hermes bridge protocol.

## scan_output

- Bounded source search found the incompatible boolean check in `dsh-appserver-adapter.ts` and object-form client requests in `resume-history.ts` / session tests.

## handoff

- Source repair is implemented and the fresh signed build is installed at
  `/Applications/OpenCraft.app`; the previous bundle is recoverable from the
  release backup path above. The original indefinite restore and false review
  marker no longer reproduce. The affected legacy Thread now terminates with a
  distinct dynamic-tool registration error, so end-to-end conversation recovery
  remains a follow-up rather than being hidden behind the completed installation.
