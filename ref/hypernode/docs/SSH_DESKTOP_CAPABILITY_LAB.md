# SSH Desktop capability lab

HyperNode treats the unmodified Codex Desktop Renderer as a protocol client. The SSH node can
provide native Desktop features only by implementing the official app-server contract; runtime
plugins are an independent, operator-controlled Cordis extension surface and are never presented
as Desktop plugins automatically.

Run the capability report with:

```sh
npm run report:desktop-host
```

The report joins four evidence sources:

1. the checked-in official app-server JSON schema;
2. string-level call sites in the recovered Renderer source tree;
3. direct Cordis handlers and explicit per-user Codex backend routes;
4. real request/error observations from the 9988 SQLite event log.

Generated JSON and Markdown reports are written beneath `.runtime/reports/`, which is deliberately
not committed because both Desktop versions and live traffic evolve. Override inputs with
`HYPERNODE_RENDERER_SOURCE`, `HYPERNODE_DATABASE`, and `HYPERNODE_CAPABILITY_REPORT_DIR`.

## Native marketplace proof

The recovered Renderer builds its plugin query per `hostId`, sends `plugin/list` to that host, and
caches the result for six hours. HyperNode's `DesktopPluginCatalog` Cordis service therefore exposes
the built-in HyperNode management skill through the native Skills & Apps / Plugins / Marketplace UI.
It implements the official `plugin/list`, `plugin/installed`, `plugin/read`, `plugin/skill/read`,
`plugin/install`, `plugin/uninstall`, `marketplace/add`, and `marketplace/upgrade` response shapes.

The first catalog item is intentionally small. It proves the important architectural point: an SSH
host can supply a host-scoped Desktop marketplace without changing Renderer code. More skills, apps,
MCP servers, hooks, and scheduled-task summaries can be projected through the same catalog after
their execution contracts are implemented.

## Interpreting route classes

- `builtin`: handled by the app-server transport itself, such as `initialize`.
- `local`: owned by a HyperNode Cordis service.
- `user-control-backend`: forwarded to the connecting user's real Codex control runtime.
- `transparent-thread`: conditionally forwarded when `threadId` identifies a HyperNode transparent
  Thread. It is not evidence that the method works for an arbitrary or unknown Thread.
- `unclassified`: no deterministic route was found. An observed unclassified request is the most
  useful target for the next protocol experiment.

The report does not claim that every string occurrence is a reachable UI feature. A feature is
promoted only after a real Desktop request and a protocol-level E2E establish its behavior.
