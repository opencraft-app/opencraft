# OpenCraft permission modes · 2026-09-26

## goal

Move the permission picker toward bb's product-level modes: the Host classifies verified native policies, publishes stable product-mode selection IDs, translates them at execution, and DSH applies the resulting preset before execution. Preserve engine-native/custom profiles.

## non_goals

- No production rollout, service replacement, commit or push in this task.
- This increment does not add bb's organization-level permission ceiling or a persisted requested-versus-effective policy ledger. Those require a separate Host enforcement and recovery contract; the UI must not claim they already exist.
- No synthetic `auto` choice without an engine-confirmed automatic reviewer.

## requirement_ids / requirement_refs / requirement_excerpt

- User request in this conversation: “按 bb 的形式 进行整改吧”.
- Previous comparison: bb modes and Host ceiling are the desired direction; DSH/Paseo-style native profiles remain useful as a compatibility escape hatch. No external ticket was supplied.

## interface_refs / data_structure_refs

- `opencraft/packages/appserver-protocol/src/permission-modes.ts`: v1 Host extension and optional catalog metadata.
- Native `permissionProfile/list`, `thread/start`, `thread/fork`, `turn/start` stay the execution protocol; standard `opencraft:permission-mode:*` IDs are translated to current native IDs at Host submission boundaries.
- `opencraft/apps/local-agent-host/src/dsh-capability-plugin.mjs` `/permissions` exposes preset specifications (`sandbox`, `approval`); `dsh-thread-engine.mjs` applies `permissionPreset` during setup.
- `opencraft/packages/chat-runtime/src/models.ts` currently carries the effective native profile ID but not a separate requested/effective product policy.

## history_context

- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `opencraft/docs/execution-ownership.md`, `opencraft/design/invariants.md`.
- `relevant_evolution`: local `ref/bb` at `62fe3bc` has `accept-edits|auto|full`, Provider capability validation, and Host ceiling; local `ref/paseo` at `3cc4ae2` keeps provider-specific mode IDs. Current native Codex AppServer `0.156.1` returned only `:read-only`, `:workspace`, and `:danger-full-access` in a read-only catalog probe.
- `superseded_refs`: none.

## acceptance

- Only Host-confirmed built-ins/presets receive standard mode metadata; custom profiles stay visible as native.
- DSH rejects an unavailable selected preset, applies a valid one at Thread creation and checks the effective profile before acknowledging it; Turn changes and Forks are also checked.
- The Web picker reads the versioned Host metadata instead of guessing mode from profile ID, and keeps native choices separate. Resumed native effective IDs map back to stable display IDs.
- Focused typechecks, unit/integration tests and a real DSH Host smoke pass; Web build passes. Browser UI smoke is reported separately if tooling is unavailable.

## affected_paths

- `opencraft/packages/appserver-protocol/`, `opencraft/apps/local-agent-host/`, `opencraft/apps/opencraft-daemon/`, `opencraft/packages/workbench-runtime/`, `opencraft/packages/codex-composer/`, `opencraft/apps/workbench-web/`, `opencraft/tests/`, `opencraft/scripts/`, `opencraft/design/invariants.md`.

## required_context

- Root Context Router query: `opencraft session permission profiles standardized product policy Codex DSH Host composer`; the identity-access match was a false positive from “session”. The relevant local OpenCraft instructions and Agent runtime formal documents govern this task.

## context_receipt

| File | Reading reason | Decision influenced |
|---|---|---|
| `AGENTS.md@HEAD` | Monorepo authority and Task Pack rules | No deployment/commit; record context and validation |
| `opencraft/AGENTS.md@HEAD` | OpenCraft Host/Renderer responsibility | Host owns capability, UI only projects |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@HEAD` | Triggered maintenance skill | Avoid cosmetic permission claims; verify real chain |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@HEAD` | Verification routing | Distinguish unit, build, real Host, real UI evidence |
| `docs/context/domains/identity-access.md@HEAD` | Router must-read false positive | Confirm unrelated to Agent execution permission |
| `docs/context/domains/agent-gateway-runtime.md@HEAD` | Agent runtime context | Keep provider facts behind Host boundary |
| `docs/context/project/adjacency/frontend-runtime-openspec-i18n.md@HEAD` | Adjacency check | No direct permission neighbor; source/test scan governs |
| `docs/engineering/domains/agent-gateway-runtime.md@HEAD` | Formal domain design | OpenCraft is the relevant runtime owner |
| `opencraft/docs/platform-architecture.md@HEAD` | Platform ownership | Client/Host/Server boundaries stay distinct |
| `opencraft/docs/execution-ownership.md@HEAD` | Execution admission and recovery | DSH applies permissions at Thread creation, not first Turn |
| `docs/context/tasks/TASK-TEMPLATE.md@HEAD` | Task structure | Acceptance, risks and handoff recorded |

## evidence

- Focused TypeScript project checks for protocol, Composer, DSH Host, Codex daemon and Web: passed.
- 98 focused AppServer/DSH/Chat tests passed before the final policy-input guard; the 22 directly affected tests passed again after it. Web Vite production build, six TypeScript project checks and platform boundary check passed after final source changes.
- Isolated real DSH Host smoke: selected workspace preset applied at Thread creation, local model round trip passed. The first run exposed actual DSH preset shape (`sandbox: "workspace-write"`), which was corrected and re-tested.
- Native Codex AppServer read-only `permissionProfile/list` probe: three built-ins, no independent auto-review profile.
- Browser UI smoke not run: Playwright/Chromium are unavailable in this container; source-level picker test and build passed.
- `git diff --check`, documentation validation and change-impact validation passed; the latter flags `wisp/mono2-maintainers` owner review for the Agent runtime surface.

## risks

- Native IDs remain the engine's effective state; a Provider change or stale catalog can still require reselection. Mitigation: Host re-resolves a standard ID on submit, validates the native preset and maps effective native IDs on resume.
- A preset can be changed by an external native DSH actor after catalog load. Mitigation: re-read effective state after Host writes. Full continuous policy ceiling is future work.
- Local DSH fallback without native Thread engine may have different cleanup behavior if a post-create permission check fails. Existing Thread-engine path releases the failed child.

## validation

- Run `git diff --check`, TypeScript project checks, focused tests, real DSH smoke, Web build, context change-impact validator and platform boundary checker.

## decisions

- Use Host-verified product IDs in the existing catalog and translate at the Host boundary; this preserves compatibility with custom profiles and unpatched hosts.
- Keep `auto` in the shared vocabulary but advertise it only when a Host can prove the automatic reviewer. No current built-in Codex profile does so.
- Do not silently install a non-default permission ceiling without an explicit deployment policy. A full bb-like ceiling needs admission checks on inherited/resumed and queued execution, not just disabled menu items.

## scan_scope

- Bounded exact searches in `opencraft/apps`, `opencraft/packages`, `opencraft/tests`, local fixed `ref/bb` and `ref/paseo` snapshots.

## scan_output

- Source anchors and concise findings above; no bulk scan output committed.

## handoff

- Source implementation and focused verification complete for this increment; no running service was replaced. Full bb-style permission ceiling and persisted requested/effective-policy reconciliation remain follow-ups, not implicitly shipped.
