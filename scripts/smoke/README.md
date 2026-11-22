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
actually exercised; CI selection and the [build matrix](../../docs/develop/build-matrix.md)
define the checks for a contribution.

## Deployed environment probe

`npm run smoke:upgrade:environment -- /private/probe.json /private/new-report.json`
reads a deployment through an existing SSH alias. It checks dependency readiness,
compares the running Core program hash and optional Web/build identity, and records
bounded systemd/Docker state, restart counts and error-journal counts. It does not
restart services or perform an upgrade. Counts are observations rather than a
new deployment policy; compare reports before and after a change.

The target requires Linux `/proc`, Python 3.6 or newer and the relevant systemd
or Docker tools. The local machine needs SSH configured for unattended access.
Keep connection configuration and reports outside the repository. Example:

```json
{
  "sshAlias": "deployment-fixture",
  "port": 10080,
  "coreProgram": "/opt/opencraft/runtime/core.mjs",
  "units": ["example.service"],
  "containers": [],
  "since": "1 hour ago",
  "expectedIdentity": {
    "buildId": "expected-build",
    "coreSha256": "replace-with-the-reviewed-program-sha256"
  }
}
```

The Core PID must identify the exact configured absolute program in its argv;
the program is hashed through that process's root. Reports contain the selected
identity and counters, never the complete process command line or journal body.
Optional identity fields are `version`, `buildId`, `webSourceRevision`,
`webBuildId`, and `coreSha256`. A new report is created exclusively with mode 0600;
failed checks return a nonzero exit code. This probe complements the admitted CLI
checks in `server/smoke-upgrade.mjs` rather than replacing them.
