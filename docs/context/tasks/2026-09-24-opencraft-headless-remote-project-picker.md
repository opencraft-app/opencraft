## goal
Allow a Mac browser connected to the headless Linux OpenCraft server to browse and select folders on that Linux server for a new task.

## non_goals
- Open a macOS native folder dialog from Web or upload the Mac's local folders.
- Change the service user, filesystem permissions, or unauthenticated-public deployment policy.

## requirement_ids / requirement_refs / requirement_excerpt
- User report, 2026-09-24: Web Add project is disabled with `This node does not advertise a browse root` while using the Linux server from a Mac.

## interface_refs / data_structure_refs
- Packaged Web Host definition `workspaceBrowseRoots` for `opencraft-server`.
- `vela.headless-codex` Host profile contribution for `local-codex`.
- Existing AppServer `fs/readDirectory` and `project/list/create` requests remain Server-owned.
- Existing browser directory picker must stay within its advertised root.

## history_context
- `current_design_refs`: `opencraft/docs/platform-architecture.md`, `docs/engineering/domains/agent-gateway-runtime.md`.
- `relevant_evolution`: headless WebUI and Codex Host already have a remote directory picker and filesystem RPC, but packaged Host metadata declares no browse root. Existing IndexedDB seed is written only on an empty profile store.
- `superseded_refs`: none.

## acceptance
- Packaged Linux Web definitions advertise an actual Linux browse root for DSH and Codex nodes.
- Existing browsers with an older empty-root seeded profile gain that root without losing unrelated profile fields.
- `/` root path containment and parent navigation work.
- Browser can open Add project and navigate remote directories; no macOS picker or local path is used.
- Focused tests, Web typecheck, relevant Host tests, native package smoke and real Mac browser verification.

## affected_paths
- `opencraft/scripts/package-headless-linux.mjs`
- `opencraft/plugins/builtin-agents/src/index.ts`
- `opencraft/apps/workbench-web/src/runtime/`
- `opencraft/apps/workbench-web/src/components/workspace-directory-model.ts`
- Relevant tests and formal design docs.

## required_context
- Context router returned no matching pack; OpenCraft local Agent entry, maintenance skill and verification checklist apply.

## context_receipt
| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md@working-tree` | Service constraints | Scope and gates |
| `opencraft/.agents/skills/opencraft-maintenance/SKILL.md@working-tree` | OpenCraft maintenance workflow | Ownership and actual UI evidence |
| `opencraft/.agents/skills/opencraft-maintenance/references/verification.md@working-tree` | Relevant test matrix | Select Host and project checks |
| `docs/context/tasks/TASK-TEMPLATE.md@working-tree` | Task Pack contract | Record this task |

## evidence
- Current Linux `local-codex` AppHost returned successful results for `fs/readDirectory` and `project/list`, without exposing returned directory names.
- `new-thread-draft-page.tsx` disables Add project when no native picker and no `workspaceBrowseRoots`; packaged DSH and headless Codex profiles both declare empty roots.
- Existing IndexedDB Host profile seed is applied only when the store has zero rows, so updating the packaged seed alone would not repair current browser profiles.
- Focused Host/profile/directory tests passed 25/25; `test:projects` passed 19/19, `test:headless-server` 15/15, `test:appserver` 205/205; Web and builtin-agents typechecks, boundary check and Web release build passed.
- Linux x64 archive SHA-256 `c82755fe3abc9853c40d894a459e52a67895f4dd5c336cc49df8e3fc817ee834`, build ID `20260924075922-075bd8b7df75`. Isolated archive smoke passed with real DSH and Codex remote `fs/readDirectory` and `project/create` calls; no paid inference.
- On the authorized test host, systemd runs the new release as UID/GID 0 with `/` read-only, `/data` read-write, `ProtectSystem=strict` and `ProtectHome=yes`; the public Codex AppHost wrote an exact 2-byte probe to `/data`, which was then removed.
- An existing Codex session initially failed to restore because its absolute rollout path still pointed into `/var/lib/private/...` after `DynamicUser=no` relocated the StateDirectory. A narrow legacy-path symlink to the same state directory restored the session; real browser Retry then showed its history.
- A fresh Mac browser opened Add project under both Codex and OpenCraft Server and browsed the Linux root; Codex navigation into `/data` displayed its remote subdirectories. The picker was cancelled without creating a project in the live service.

## risks
- The public test server has no authentication; a `/` browse root exposes every directory readable by the systemd service to connected browsers. By explicit user choice, it now runs as root, while the mount namespace keeps `/` read-only and grants `/data` read-write. Anyone with WebUI access may operate on `/data` as root.
- Do not overwrite unrelated user Host profile settings during root migration.

## validation
- Focused headless, Host-profile and workspace directory model tests, Web and plugin typecheck, boundary check, Linux package smoke, real Web UI.

## decisions
- Linux headless package advertises `/` as a browse root, letting OS permissions decide which folders are actually accessible. Both built-in nodes consume the same bundled root declaration.
- User clarified that OpenCraft should act as an OS steward but must not have the entire `/` writable. The test service therefore uses root UID with `ReadWritePaths=/data` under `ProtectSystem=strict`; other service isolation remains.

## scan_scope
- `opencraft/apps/workbench-web/src`, `opencraft/plugins/builtin-agents/src`, `opencraft/scripts`, `opencraft/tests`.

## scan_output
- Bounded exact searches for browse-root and project-directory contracts.

## handoff
- Source and test-server deployment complete. Previous unit backed up at `/var/backups/opencraft/opencraft-server-before-root-data-20260924.service`; state backup at `/var/backups/opencraft/opencraft-state-before-root-data-20260924.tar.gz` (both mode 0600). Previous release `/opt/opencraft-server/releases/6ee49d0996855fda` remains for rollback. No commit or push. Private Git repository authentication is a separate concern from filesystem write access.
