---
id: opencraft-machine-resource-lifecycle
type: task
scope: Separate OpenCraft machine resource lifecycle from Host connection, runtime readiness, and task activation.
triggers: ["machine lifecycle", "Local status dot", "cloud resource lifecycle"]
owner: wisp/mono2-maintainers
authority: primary
source_of_truth:
  - opencraft/packages/workbench-runtime/src/environment-directory/contract.ts
  - opencraft/packages/workbench-runtime/src/environment-directory/directory.ts
  - opencraft/apps/workbench-web/src/runtime/appserver-runtime-context.tsx
status: active
reviewed_at: 2026-09-17
review_due: 2026-12-16
revision: 1.0.0
precedence: task
derived: false
---

## goal

Model provider-managed cloud resource lifecycle independently from physical Host connection, runtime readiness, and task activation; make the Local composer indicator consume only physical Host connection state.

## non_goals

- Do not make OpenCraft create, suspend, resume, or remove a cloud resource unless its owning provider explicitly advertises and implements that action.
- Do not reinterpret `provisionHost()` as cloud allocation; it remains connection-profile persistence.
- Do not add resource lifecycle to local DSH or user-supplied WebSocket/SSH Hosts.

## requirement_ids / requirement_refs / requirement_excerpt

- User request, 2026-09-17: follow BB's separation strictly and introduce cloud machine lifecycle without conflating it with Local connection status.

## interface_refs / data_structure_refs

- `HostConnectionProvider`: physical transport construction only.
- `EnvironmentSource`: authoritative discovery owner for provider-managed resources.
- `MachineResourceLifecycle`: canonical resource phase, raw provider phase, provider identity, message, and explicit action capabilities.
- `WorkbenchCoordinator.phase`: task/View activation only; never a Host connection indicator.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: `ref/bb` keeps `host.status`, machine lifecycle, environment readiness, and submission errors separate; only provider-managed machines accept lifecycle actions.
- `superseded_refs`: none.

## acceptance

- Local status dot reflects the selected Host runtime connection phase, not coordinator activation errors.
- Configured/local Hosts expose no cloud resource lifecycle.
- LightVela environments normalize authoritative instance status into a canonical resource lifecycle while preserving the raw status.
- Resource actions fail closed unless the source advertises both capability and an action handler.
- Focused runtime/UI tests, affected typechecks, boundaries and Web/Electron builds pass.

## affected_paths

- `opencraft/packages/workbench-runtime/src/environment-directory/`
- `opencraft/plugins/lightvela-platform/src/environment-directory/`
- `opencraft/apps/workbench-web/src/`
- `opencraft/tests/`

## required_context

- No context route matched the exact query; bounded search recorded before implementation.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `AGENTS.md@worktree` | Repository change boundaries. | Preserve dirty worktree and delivery authorization. |
| `opencraft/AGENTS.md@worktree` | OpenCraft ownership and verification. | Keep Host, runtime, resource and View lifecycles separate. |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@worktree` | Maintenance method. | Define owners and live evidence before presentation. |
| `opencraft/docs/platform-architecture.md@worktree` | Current Host architecture. | Keep transport and profile persistence semantics stable. |
| `ref/bb/packages/domain/src/host.ts@worktree` | Requested reference model. | Separate connection and managed resource lifecycle. |
| `ref/bb/apps/server/src/services/machines/provider-orchestration.ts@worktree` | Requested reference behavior. | Fail closed for unmanaged resources and active work. |

## evidence

- TDD red/green cycles covered Host connection ownership, provider phase normalization, managed-resource projection, fail-closed action routing and secondary lifecycle copy.
- `npm run test:environments`: 27 passing; focused Workbench/navigation suites: 35 passing; affected Runtime/Web/LightVela typechecks and platform boundaries pass.
- `npm run build:lightvela-web` and `npm run build:electron` pass.
- An isolated Electron profile on CDP 9337 reported the Local indicator as `phase=ready`, `Connected`; its menu row rendered `Connected Local · This device`. Evidence: `/tmp/opencraft-machine-lifecycle-local-ready.png`. The temporary Electron process/profile were removed without touching existing previews.
- A follow-up visual regression caught and fixed the menu text-container selector stretching the shared status dot. Isolated Electron evidence now measures the ready dot at exactly `7×7px`, `flex: 0 0 7px`, `border-radius: 50%`; screenshot: `/tmp/opencraft-status-dot-fixed.png`.

## risks

- A resource phase must not overwrite Host connection or Task activation state.
- Provider raw statuses are open vocabulary; unknown values must remain visible and normalize to `unknown`.
- Destructive resource actions require an explicit provider capability and separate confirmation UI before a future surface exposes them.

## validation

- Focused environment-directory and Workbench status tests.
- Affected package typechecks, platform boundaries, Web and Electron builds.
- Local preview verifies connection/status presentation without mutating cloud resources.

## decisions

- Reuse EnvironmentSource as the cloud-resource authority; do not add lifecycle methods to HostConnectionProvider.
- `resource: null` means the Host is not provider-managed.
- This slice adds the fail-closed action contract but no destructive UI and no fabricated provider actions.

## scan_scope

- `opencraft/packages/workbench-runtime`, `opencraft/apps/workbench-web`, `opencraft/plugins/lightvela-platform`, `ref/bb` machine lifecycle paths.

## scan_output

- Direct bounded source trace; Graphify explicitly prohibited by the user.

## handoff

- Complete in the current worktree. No commit, push, merge or cloud mutation was performed.
- LightVela currently advertises no suspend/resume/remove resource capability, so this revision adds no destructive cloud control. A future provider can implement the existing fail-closed port with its own confirmation UI and operation reconciliation.
