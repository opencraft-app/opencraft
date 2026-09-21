## goal

Define the authoritative OpenCraft directory model for packaged desktop state,
runtime cwd, product home, DSH state and Thread workspaces, including safe
migration away from Vela-named profile directories.

## non_goals

- Do not move the live installed user's data during source implementation.
- Do not change bundle identifiers, wire IDs, plugin IDs or serialized schemas.
- Do not merge platform-private Electron state into portable product home.

## requirement_ids / requirement_refs / requirement_excerpt

- User requirement: distributed Mac App processes and data use stable,
  OpenCraft-owned directories; `@vela/workbench-electron` must be removed as the
  canonical user-data identity.

## interface_refs / data_structure_refs

- `app.setPath("userData", ...)`, `process.resourcesPath`, Daemon spawn `cwd`.
- `OPENCRAFT_HOME` / `~/.opencraft` product root.
- Explicit Project/Thread cwd and projectless workspace allocation.
- Legacy profile migration before instance and daemon ownership.

## history_context

- `current_design_refs`: `opencraft/docs/architecture/product-identity.md`.
- `relevant_evolution`: display rebranding previously preserved the Vela profile
  path to avoid data loss; the new requirement promotes OpenCraft paths with an
  explicit compatibility migration instead.
- `superseded_refs`: `@vela/workbench-electron` as a canonical write target.

## acceptance

- One resolver owns all desktop paths.
- Production and Preview are isolated and Vela-free at canonical destinations.
- Managed process cwd is explicit; Agent workspace never falls back to it.
- Existing profiles migrate atomically or remain intact on the legacy root.
- Explicit test profile overrides never migrate production data.

## affected_paths

- `opencraft/docs/architecture/product-identity.md`
- `opencraft/AGENTS.md`
- `opencraft/apps/workbench-electron/src/product-identity.ts`
- `opencraft/apps/workbench-electron/src/desktop-directories.ts`
- `opencraft/apps/workbench-electron/src/main.ts`
- `opencraft/apps/workbench-electron/src/daemon-client.ts`
- `opencraft/apps/opencraft-daemon/src/bin.ts`
- `opencraft/apps/opencraft-daemon/src/main.ts`
- `opencraft/apps/local-agent-host/src/main.ts`
- `opencraft/apps/local-agent-host/src/dsh-supervisor.ts`
- `opencraft/apps/local-agent-host/src/dsh-thread-engine.mjs`
- `opencraft/tests/desktop-directory-identity.test.ts`
- `opencraft/tests/product-identity.test.ts`
- `opencraft/tests/dsh-thread-engine.test.mjs`
- `opencraft/package.json`

## required_context

- No router Pack matched; bounded exact source/reference search was used.

## context_receipt

| 文件 | 阅读原因 | 用途 |
|---|---|---|
| `opencraft/AGENTS.md` | Desktop and documentation boundaries | Add a short mandatory routing rule. |
| `opencraft/docs/architecture/product-identity.md` | Existing identity authority | Extend instead of creating a competing design truth. |
| `ref/codex/settings/resolve-codex-config-directory-01184.ts` | Codex product-root reference | Separate stable product home from Thread cwd. |
| `ref/wb/.../workbuddy-agent-adapter-next.ts` | WorkBuddy product configuration reference | Keep data-folder identity product-owned. |
| Current installed OpenCraft process/source | Runtime evidence | Main, Daemon and DSH inherited cwd `/`; userData remained Vela-named. |

## evidence

- Installed `/Applications/OpenCraft.app` Main, Daemon and DSH all reported cwd `/`.
- Current Main explicitly selects `@vela/workbench-electron`; Daemon spawn omits
  cwd; DSH has `process.cwd()` fallbacks.
- Codex resolves `CODEX_HOME` or `~/.codex`; WorkBuddy exposes product-owned
  `dataFolderName` and uses `~/.workbuddy` paths.
- Final packaged explicit-profile smoke proved Main/GPU/Network/Renderer used
  one profile, Main/Daemon/DSH used its `runtime/` cwd, product home stayed
  separate, and no real OpenCraft profile was left behind.
- Filesystem migration tests preserved durable data and token, removed stale
  socket state, created the rollback link, deferred an active legacy owner and
  rolled back an injected post-rename failure.
- Authorized local installation used Developer ID build
  `20260918063832-3b5a40663c3c`. The old application is backed up at
  `opencraft/apps/workbench-electron/release/install-20260918-directory-identity/previous-OpenCraft.app`.
  First launch atomically migrated the real profile to `Application Support/OpenCraft`;
  the legacy path is now a compatibility symlink, Thread catalog remained present,
  Local reached Connected, existing tasks rendered, and Main/Daemon/DSH cwd all
  resolved to `OpenCraft/runtime`.

## risks

- Switching the directory name without migration presents an empty profile.
- Copy migration can split SQLite/socket ownership; prefer same-volume rename
  plus rollback compatibility link.
- Old and new binaries may race; migration must be lock-aware and idempotent.

## validation

- `npm run test:identity`.
- Identity and packaging tests: 21 passed.
- `npm run test:dsh-bridge` (227 passed).
- Desktop/Daemon focused tests (18 passed).
- `npm run typecheck`.
- Electron build, ad-hoc packaged explicit-profile launch, process/path/cwd and
  visible-window verification.
- Developer ID deep/strict verification, installed bundle hash parity, graceful
  old-app shutdown, recoverable application replacement and live profile migration.
- Documentation, boundaries, bounded change-impact and diff checks.
- All listed validation commands passed; change-impact still requires normal
  `wisp/mono2-maintainers` review when delivered through an MR.

## decisions

- Canonical macOS desktop root is `Application Support/OpenCraft`; Preview uses
  `Application Support/OpenCraft Preview`.
- Canonical runtime coordination files are `opencraft-daemon.sock` and
  `opencraft-daemon.token`; legacy socket files are not durable migration data.
- Portable product home is `OPENCRAFT_HOME` or `~/.opencraft`.
- Runtime cwd and Thread workspace cwd are separate authorities.
- Legacy Vela paths remain migration inputs only.

## scan_scope

- OpenCraft Electron/Daemon/DSH path resolution, `ref/codex`, and `ref/wb` product
  root and session cwd behavior.

## scan_output

- Bounded exact-search evidence summarized above; no generated trees modified.

## handoff

- Source implementation, packaged validation, authorized application replacement
  and real profile migration are complete locally. The application remains
  running from `/Applications/OpenCraft.app`; source is not committed or published.
