# Dynamic MCP App Builder

Hypernode exposes `hypernode-app-builder` as a fixed MCP server and
`build-mcp-app` as its entry Skill. An authenticated SSH user can validate and
save an App draft, publish immutable releases, and atomically roll back to an
older release without restarting the process listening on port 9988. Apps can
also be unpublished or permanently deleted from any owner DSH conversation.

## Release model

- Every publish creates a monotonically increasing immutable release `rN`.
- The active release is one durable pointer. Publishing and rollback replace
  the live MCP server and virtual Skill in the same policy event.
- The UI resource is addressed by the SHA-256 digest of the complete HTML:
  `ui://hypernode/apps/<app-id>/sha256-<digest>.html`.
- A backend-only edit creates a new release but reuses the UI URI. Any UI byte
  change creates a new URI, so clients cannot confuse two different bundles.
- A tool call resolves its server registration once. Calls already in flight
  keep the release closure they started with; later calls see the active release.

The catalog is stored in `do_mcp_apps` and `do_mcp_app_releases`. Drafts and
the active pointer are mutable; release payloads are append-only.

## Builder tools

- `appBuilder.list`
- `appBuilder.get`
- `appBuilder.validate`
- `appBuilder.saveDraft`
- `appBuilder.publish`
- `appBuilder.rollback`
- `appBuilder.unpublish`
- `appBuilder.delete`

`unpublish` removes the live MCP server and launcher Skill while preserving the
draft and immutable releases. `delete` removes the runtime registration, draft,
and every release without a second confirmation turn. Both remain owner-only;
runtime removal broadcasts the native `skills/changed` invalidation signal.

Generated Apps are owner-scoped: their MCP inventory, UI resources, tools, and
Skill entry are visible only to the SSH principal that created them.

Generated tools support static, echo, and JavaScript handlers. JavaScript is
compiled before activation and runs inside the server QuickJS policy realm
with `args` and immutable release/tool context in scope. This is deliberately
a trusted-node capability: App authors can execute policy-realm code, so App
publication must remain restricted to SSH principals trusted as node authors.

The `build-mcp-app` Skill is a DSH-only Agent capability. A user describes the
App in natural language; the DSH Agent reads the UI-quality reference,
generates the full spec, and invokes the host `manage_mcp_app` capability to
validate, publish, roll back, unpublish, or delete it. Codex execution is intentionally out of scope. The
JSON/HTML editor is retained only as an advanced diagnostics surface.
