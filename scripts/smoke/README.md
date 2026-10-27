# Smoke checks

These scripts exercise real runtime and presentation boundaries. Run them from
the repository root, using the existing `npm run smoke:*` commands when an alias
is available. A script's prerequisites and inputs still apply after a file move;
some checks need a built application, an isolated Host, a desktop or a configured
external endpoint. Running every script is not a single offline test suite.

| Directory | Scope |
| --- | --- |
| `browser/` | Browser sessions, remote pages and browser controls |
| `composer/` | Composer input, dictation and speech interaction |
| `conversation/` | Conversation presentation, history, queues, turns and lifecycle |
| `desktop/` | Electron, packaged desktop clients and native project selection |
| `execution/` | Host/engine adapters, models, accounts, SSH and execution ownership |
| `extensions/` | Client extensions, connectors, MCP Apps and plugin settings |
| `resources/` | Attachments, file trees, documents, media and resource delivery |
| `server/` | Headless packages, managed updates and deployed Web resources |
| `shell/` | Navigation, sidebar, controls, themes and layout |
| `tasks/` | Tasks, schedules and linked conversations |

Keep generic build, packaging and development commands directly under `scripts/`
or in their existing specialized directories. Browser fixtures stay under
`tests/fixtures/` and `scripts/fixtures/`; shared smoke setup stays with its owning
utility. Add new smoke scripts to the relevant domain above and update command,
workflow and documentation references together.

Reports and temporary profiles belong in ignored `.local/` or an explicit
isolated output directory. A smoke result proves only the runtime and scenarios
actually exercised; CI selection and the [build matrix](../../docs/build-matrix.md)
define the checks for a contribution.
