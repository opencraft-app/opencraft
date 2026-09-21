---
id: opencraft-agent-runtime-directory
type: task
scope: Establish an application-owned Agent Runtime readiness and AppServer request boundary for Local DSH, Skills, and Model Services.
triggers: ["Agent Runtime", "No AppServer client", "Local DSH pending"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/agent-runtime/
  - opencraft/packages/workbench-runtime/src/host-runtime-registry.ts
  - opencraft/packages/workbench-runtime/src/appserver-runtime.ts
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Make Agent Runtime readiness an application-owned invariant so Local DSH protocol requests wait for the Host Runtime instead of racing the raw AppServer client registry.

## non_goals

- Do not change the shared AppServer protocol, DSH wire methods, or Hermes RPC.
- Do not merge machine lifecycle, transport connection, protocol readiness, account state, or task activation.
- Do not move Thread, Skills, or model domain state into a new all-purpose manager.
- Do not add visible connection prose; pending presentation remains an in-place icon.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-17: adopt the larger Codex/BB-informed runtime model, preserve the AppServer protocol, avoid a large mud-ball file, and represent pending with an icon only.

## interface_refs / data_structure_refs

- `AgentRuntimeDirectory`: application request/readiness boundary.
- `HostRuntimeRegistry`: Host identity, lazy runtime creation, connect deduplication, and disposal owner.
- `AppServerWorkbenchRuntime.resources.protocol`: initialized protocol-session port.
- Invariant: domain code may request a Host runtime; it must not read `AppServerClientRegistry` directly.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `docs/context/tasks/2026-09-16-appserver-transport-generation-reconnect.md`, `docs/context/tasks/2026-09-17-opencraft-machine-resource-lifecycle.md`.
- `relevant_evolution`: Codex gates renderer services behind AppHost startup and resolves per-Host runtime managers; BB keeps machine/Host/session truth separate. OpenCraft already owns Host factories but Model Services bypasses them through the raw client registry.
- `superseded_refs`: none.

## acceptance

- A protocol request issued before the Local runtime is connected remains pending and resumes after the same application-owned runtime becomes ready.
- Skills target activation establishes its selected runtime before checking the Profile Skills capability.
- Model Services loading uses an accessible in-place pending icon without visible connection prose.
- AppServer wire methods and payloads remain unchanged.
- Focused runtime, Skills, Model Services, boundary, typecheck, Web and Electron checks pass.

## affected_paths

- `opencraft/packages/workbench-runtime/src/agent-runtime/`
- `opencraft/packages/workbench-runtime/src/appserver-runtime.ts`
- `opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx`
- `opencraft/packages/extension-react/src/index.ts`
- `opencraft/plugins/builtin-agents/src/model-services/`
- `opencraft/plugins/lightvela-hermes/src/settings/`
- `opencraft/tests/`
- `opencraft/docs/platform-architecture.md`

## required_context

- Context route `OpenCraft AgentRuntime Local DSH AppServer readiness Skills Model Services pending icon` returned no Pack; bounded exact search was used.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Repository mutation and validation boundary. | Preserve the dirty worktree and avoid unauthorized delivery. |
| `opencraft/AGENTS.md@worktree` | OpenCraft ownership and preview rules. | Keep Application, Host, runtime and View lifecycles distinct. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Required OpenCraft maintenance method. | Choose the smallest boundary that restores the readiness invariant. |
| `opencraft/docs/platform-architecture.md@worktree` | Current Application Supervisor and Host topology. | Extend the existing topology rather than introduce a parallel owner. |
| `opencraft/docs/build-matrix.md@worktree` | Desktop/Web artifact boundary. | Validate Electron because Local DSH belongs to the desktop host. |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@worktree` | Required adjacency check after exact search. | Confirm an adjacent UI test is updated; no frontend i18n generation is involved. |
| `ref/codex/service/app-server-manager-registry-06127.ts@worktree` | Requested Codex runtime reference. | Use waitable Host runtime resolution, not raw client lookup. |
| `ref/bb/apps/server/src/services/hosts/online-rpc.ts@worktree` | Previously requested BB control-plane reference. | Preserve typed command/readiness and Host/session separation. |

## evidence

- TDD: `agent-runtime-directory.test.ts` proves a protocol request remains pending before application binding, waits through Host `connecting`, and runs only after Runtime readiness; terminal startup failure rejects waiters.
- Focused Runtime/Skills/Model Services/Environment/AppServer suites: 60 passing; follow-up Daemon/Local Host/Runtime suites: 14 passing.
- Affected Workbench Runtime, Web, Hermes, Local Agent Host, Daemon and Electron typechecks pass; `npm run check:boundaries`, `npm run build:lightvela-web`, and `npm run build:electron` pass.
- Full `npm run gate` passed all workspace typechecks and every stage through AppServer, extensions, projects, Thread lifecycle, native speech and DSH bridge, then stopped on one pre-existing Workbench unit expectation: `workbench-timeline-host.test.ts` still expects the old six-field menu metrics object while the dirty design-system source already adds three bounded-size fields. The unrelated user-owned change was not modified. All later Gate stages were run explicitly and passed: shell space, workspace presentation, environments, desktop login, Web release, Web build, Expo Web export and Expo iOS bundle.
- Isolated Electron source preview on CDP 9342 loaded Model Services with 40 provider rows, no alert and no renderer exception. Skills loaded anonymously with `本机 DSH` selected, public catalog content visible, no login wall, no alert and no exception.
- Live preview exposed and then verified the pre-existing development-path bug: Daemon inherited the Electron workspace cwd and resolved a duplicated capability plugin path. Electron now passes the explicit source/package plugin path through Daemon CLI to Local Agent Host; the rebuilt preview reaches the real DSH runtime.
- Pending presentation uses the existing 7px status token or a 16px in-place loader. The Host trigger retains the target label and contains no visible `Connecting…` replacement text.

## risks

- A late-bound application directory must settle unavailable startup instead of leaving requests pending forever.
- Runtime readiness must not silently select, create, or mutate a Host.
- Old runtime generations must not fulfill requests after disposal or replacement.

## validation

- Add focused `AgentRuntimeDirectory` readiness/generation tests first.
- Run Model Services and local DSH Skills tests.
- Run affected package typechecks, `npm run check:boundaries`, Web build and Electron build.
- Launch an isolated Electron preview and inspect the Local pending/ready transition without using real credentials.

## decisions

- Add a small `agent-runtime/` topology instead of extending the existing large `appserver-runtime.ts` state machine.
- Reuse `HostRuntimeRegistry` as the Host lifecycle owner; `AgentRuntimeDirectory` only composes readiness and protocol access.
- Preserve the AppServer protocol and expose it through a narrow runtime-owned protocol port.

## scan_scope

- `opencraft/packages/workbench-runtime`
- `opencraft/apps/workbench-web/src/runtime`
- `opencraft/plugins/builtin-agents/src`
- `opencraft/plugins/lightvela-hermes/src/settings`
- related focused tests and `ref/codex` runtime registry files.

## scan_output

- Direct bounded source trace; Graphify is prohibited by the user and was not used.

## handoff

- Complete in the current dirty worktree. The isolated Electron preview remains running with profile `/tmp/opencraft-agent-runtime-preview` and CDP 9342 for user inspection.
- No commit, push, MR, release, cloud operation, credential use, or production mutation was performed.
