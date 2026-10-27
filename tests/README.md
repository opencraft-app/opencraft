# Tests

Run the named `npm run test:*` commands from the repository root. Their existing
names select focused suites; `npm test` selects the default suites, not every
test in this tree. Platform, packaging and live-service tests may need the
environment described in their owning app or build guide.

| Directory | Coverage |
| --- | --- |
| `browser/` | Browser runtime, remote sessions, input and rendering |
| `chat/` | Conversations, threads, history, timelines and message presentation |
| `composer/` | Draft editing, attachments, dictation and speech input |
| `desktop/` | Electron, native desktop bindings and cloud desktop |
| `execution/` | Engines, host execution, model configuration and recovery |
| `extensions/` | Extension lifecycle, connectors and bundled integrations |
| `identity/` | Actors, authentication and product identity |
| `mobile/` | Expo, native mobile resources and embedded runtime composition |
| `protocol/` | AppServer, connection lifecycle, Hub, relay and transport |
| `resources/` | Files, previews, attachments and transfer |
| `server/` | Headless service, deployment, observability and Web distribution |
| `shell/` | Workbench navigation, panels, settings and shared UI policies |
| `storage/` | Database lifecycle, persistence and storage migration |
| `tasks/` | Task catalog, editing, activity and schedules |
| `tooling/` | CI planning, release tooling, dependency audits and source checks |
| `usage/` | Token accounting, queries and telemetry |
| `support/` | Shared test helpers, imported by suites rather than run directly |
| `fixtures/` | Browser pages, fake services and other executable test inputs |
| `playwright/` | Web update browser suites loaded by `config/playwright.*` |

Put new tests in the directory for the behavior they cover, beside related
suites. Keep shared helpers in `support/` and browser/service inputs in
`fixtures/`. Add tests to the relevant npm command and update CI path selection
when introducing a new category; directory placement alone does not schedule a
suite. Preserve test assertions when moving files, and resolve source paths
relative to the test module or the repository root as appropriate.

Tests for downstream product adapters and site-region policies belong with the
downstream implementation and its fixtures; the standalone core must not need
private product sources to run its tests. Core Bot history is covered by
`chat/chat-bot-history-source.test.ts` and
`chat/chat-bot-history-demand.test.ts`; locale resolution is covered by
`shell/i18n-runtime.test.ts`. These suites do not establish downstream Hermes
integration or product site-region behavior.

`npm run smoke:presentation-policy` runs both default and explicitly configured
presentation in a real browser using the public build factory. It covers legacy
theme restoration, current preference priority, opaque extension IDs, shared
glyphs in page and Shadow DOM, narrow/wide viewports, draft preservation through
theme changes and saved preferences after reloads. It needs installed Playwright Chromium and
no private product configuration. Set `OPENCRAFT_PRESENTATION_REPORT` to keep its
JSON evidence and screenshots outside the checkout.
