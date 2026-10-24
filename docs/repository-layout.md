# Repository layout

The root contains the project entry points, workspace manifests, legal notices
and configuration that tools discover from the working directory. Put new files
with the area that owns them; a task's working notes are not project entry points.

| Location | Contents |
| --- | --- |
| `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `AGENTS.md` | User, contributor, security and agent entry points |
| `LICENSE`, `NOTICE`, `OWNERS`, `CHANGELOG.md` | Licensing, ownership and release history |
| `package.json`, `package-lock.json`, `tsconfig*.json`, `postcss.config.mjs`, root dotfiles | Workspace manifests, shared TypeScript settings and automatically discovered configuration |
| `apps/`, `packages/`, `plugins/` | Platform applications, shared contracts and bundled integrations |
| `docs/` | Maintained architecture, operations, build and contributor documentation; start at [the index](README.md) |
| `design.md`, `design/` | UI authoring entry, interaction specifications and topic-specific implementation records |
| `config/` | Explicitly loaded tool configuration, versioned baselines and [repository metadata](../config/catalog-info.yaml) |
| `scripts/`, `tests/` | Development/build utilities, [tests grouped by domain](../tests/README.md), [domain smoke checks](../scripts/smoke/README.md) and browser fixtures |
| `packaging/`, `runtime/`, `ops/` | Distribution templates, isolated execution-runtime inputs and service operations |
| `examples/`, `vendor/` | Runnable extension examples and separately maintained integrations or dependencies |
| `.github/`, `.agents/` | GitHub workflows and repository-local agent skills |
| `.local/` (ignored) | Machine-specific logs, screenshots, profiles and temporary verification evidence |

The optional Hermes AppServer bridge lives in
[`apps/bridges/hermes/`](../apps/bridges/hermes/README.md), with its own Bun
toolchain and lockfile outside the root `apps/*` workspace pattern. Run its
commands from that directory.

Run root-workspace npm commands from the repository root. Browser compatibility and Web update
Playwright configurations live in `config/`; package scripts resolve them
explicitly. Test discovery, browser source selection and ignored report locations
remain rooted in the workspace.

The [Harness charter](architecture/harness.md) describes behavior verification.
[Platform](platform-architecture.md) and [ChatUI](chat-ui-architecture.md)
architecture entry points index the maintained topics under
`docs/architecture/platform/` and `docs/architecture/chat-ui/`. Keep changes to
behavior and ownership in the relevant topic; the entry points retain earlier
section permalinks and provide navigation.
[Upstream history](upstream-history.md) records repository history and downstream
consumption. Historical local-project-selection notes live together under
[`design/local-project-selection/`](../design/local-project-selection/task_plan.md);
their progress and limitations describe that task's recorded state.

Keep future task plans, findings and progress under a named topic in `design/`,
or use ignored `.local/` for scratch work. Keep required third-party notices in
place. A file move must update its links, tool loaders, fixtures and CI selection
so a fresh clone works without an older checkout or private parent repository.
