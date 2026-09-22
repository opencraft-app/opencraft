## goal

Make an existing OpenCraft conversation paint from its bounded Resume history without waiting on a redundant metadata round trip or unrelated capability readiness.

## non_goals

- Do not change DSH native history storage or activate a cold Agent for display.
- Do not weaken the exact dynamic-tool registration required before execution.
- Do not change Hermes message-window deadlines or history semantics.
- Do not package, install, commit, push, or publish the application.

## requirement_ids / requirement_refs / requirement_excerpt

- User report 2026-09-20: a visibly short DeepSeek Harness conversation can remain on “Restoring conversation” for a long time; implement the diagnosed repair.

## interface_refs / data_structure_refs

- `opencraft/packages/appserver-session/src/resume-coordinator.ts`: metadata selection and `thread/resume` history strategy.
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`: Thread catalog reads, Session View seeding, Replica authoritative promotion and dynamic-tool readiness.
- Invariant: catalog metadata is a read hint, not history authority; `thread/resume` remains the single authoritative display baseline.
- Invariant: display hydration must not wait for a redundant `thread/read` when the catalog already supplied the same Thread metadata.
- Invariant: capability declarations may be deferred for a cold Agent, but execution still requires exact registration before prompt admission.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/chat-ui-architecture.md`, `opencraft/design/dsh-jit-history.md`.
- `relevant_evolution`: bounded DSH pagination and cold capability deferral already exist; current Session nevertheless performs a serial metadata preflight for every first restore.
- `superseded_refs`: none.

## acceptance

- A Thread returned by `thread/list` seeds only metadata into the Session View.
- Acquiring that Thread does not issue a redundant metadata-only `thread/read` before `thread/resume`.
- Resume/history still becomes authoritative exactly once and retains paginated history behavior.
- A cold capability declaration remains deferred without activating DSH, while execution admission remains unchanged.
- Focused Session, Workbench and boundary checks pass; a current-source Web/Electron preview is reported separately from source tests.

## affected_paths

- `opencraft/packages/appserver-session/src/view-store.ts`
- `opencraft/packages/appserver-session/src/resume-coordinator.ts`
- `opencraft/packages/appserver-protocol/src/extensions.ts`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/local-agent-host/src/dsh-appserver-adapter.ts`
- `opencraft/plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol.ts`
- `opencraft/tests/appserver-session.test.ts`
- `opencraft/tests/chat-workbench-draft.test.ts`
- `opencraft/tests/local-agent-host.test.ts`
- `opencraft/tests/lightvela-hermes-plugin.test.ts`
- `opencraft/design/dsh-jit-history.md`

## required_context

- No router Pack matched; bounded exact search was recorded before implementation.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | OpenCraft ownership and validation rules | Keep the repair in shared Session/Runtime layers and preserve real-preview gates. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md` | Maintenance workflow | Define state ownership and falsifiable acceptance before editing. |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md` | Validation matrix | Select AppServer/Chat tests and runtime evidence. |
| `opencraft/docs/platform-architecture.md` | Thread lifecycle authority | Preserve JIT display recovery and cold Agent behavior. |
| `opencraft/docs/chat-ui-architecture.md` | Resume/Replica boundary | Keep Session as V3 compatibility ingestion and Replica as display authority. |
| `opencraft/design/dsh-jit-history.md` | DSH history contract | Preserve bounded native history and strict execution registration. |

## evidence

- Before implementation, the affected one-Turn DSH session resumed in 39.8ms through the adapter, 16.5ms through the live daemon, and became authoritative in 61.6ms through Workbench Runtime.
- Existing Session code serially awaited metadata-only `thread/read` with the full request timeout and swallowed its failure before issuing `thread/resume`.
- Current source against the running daemon completed `thread/list → acquireThread → authoritative` in 49.5ms with one `thread/resume` and zero `thread/read` requests.
- DSH and Hermes now declare their history mode in the shared initialize extension, so remembered-session/deep-link startup also skips metadata preflight instead of depending on directory-list timing.
- An isolated current-source Electron profile opened successfully through CDP and rendered the Start surface; it contained no copied user history, so actual sidebar-click timing remains represented by the live-daemon protocol check rather than a fabricated UI fixture.

## risks

- Stale catalog metadata could choose the wrong history strategy; Resume response remains authoritative and seeding is replaced by its projection.
- Seeding full Turns would create a second history authority; seed only a zero-Turn metadata snapshot.
- Moving capability readiness ahead of execution could omit tools; this task does not weaken the existing turn-start registration gate.

## validation

- `npx tsx --test tests/appserver-session.test.ts tests/chat-workbench-draft.test.ts` (47 passed).
- `npm run test:appserver` (168 passed).
- `npm run typecheck --workspace @opencraft/appserver-session` (passed).
- `npm run typecheck --workspace @opencraft/appserver-protocol` (passed).
- `npm run typecheck --workspace @opencraft/workbench-runtime` (passed).
- `npm run typecheck --workspace @opencraft/local-agent-host` (passed).
- `npm run typecheck --workspace @opencraft/plugin-lightvela-hermes` (passed).
- `npx tsx --test tests/lightvela-hermes-plugin.test.ts` (78 passed; existing i18n/localStorage warnings only).
- `npm run check:boundaries` (passed).
- `npm run build:web` and `npm run build:electron` (passed; existing chunk-size and ineffective-dynamic-import warnings only).
- `python3 .agents/context/scripts/validate_change_impact.py ...` for the bounded change set (passed; `wisp/mono2-maintainers` review remains required by the mapped domain).
- `python3 .agents/context/scripts/validate_documentation.py --repo . --format json` (passed).
- Scoped `git diff --check` (passed).

## decisions

- Reuse already-fetched `thread/list` metadata instead of adding a timeout, cache, or DSH-specific protocol.
- Advertise history strategy as an engine-neutral Host capability; DSH declares `paginated`, Hermes declares `message-window`, and undeclared Hosts retain the compatibility preflight.
- Keep `thread/resume` as the only authoritative history transition.
- Keep dynamic-tool execution readiness strict; do not trade correctness for an earlier enabled Composer.

## scan_scope

- `opencraft/packages/appserver-session/src`, `opencraft/packages/workbench-runtime/src`, and their focused tests.

## scan_output

- Exact search found the redundant read in `resume-coordinator.ts`, the unseeded catalog path in `appserver-runtime.ts`, and existing authoritative promotion tests in `chat-workbench-draft.test.ts`.

## handoff

- Source implementation and verification are complete. The final rebuilt Electron bundle opened successfully in an isolated profile and rendered the Start surface through CDP, then the preview was stopped. Existing `/Applications/OpenCraft.app` was not replaced or restarted; it does not contain this source change.
