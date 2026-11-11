# Conversation CLI

Ordinary conversations may work directly or coordinate child conversations. There is no separate Manager identity or execution queue. Human SSH connection mode remains available. An execution selects the private launcher through `OPENCRAFT_THREAD_CLI`; the Host also prepends its namespace to PATH so `opencraft` is stable.

## Opening the CLI

The configured Host publishes a private launcher after Server domain admission. No `thread_cli` discovery tool is injected. Use `opencraft context` after compaction to rediscover the current authorized context. Each execution has its own namespace; do not copy another execution's descriptor. Unsupported execution adapters report `cliUnavailable` and do not restore orchestration MCP tools.

The endpoint is loopback-only, rejects browser Origin headers, and requires a live opaque Host credential. Host retains the Server-signed execution capability for forwarding. Source server, conversation and execution come from that signed scope, not command arguments. Each operation rechecks the original bounded human delegation and target resource permission. Session-only credentials and unbound executions cannot invoke the CLI. The generated private launcher/configuration live under the managed Host data directory; expiry or revocation of their delegation invalidates operations even if the files remain.

## Commands

Use `opencraft` or the launcher named by `OPENCRAFT_THREAD_CLI`:

```sh
opencraft context
opencraft thread list --children --limit 20
opencraft thread spawn --prompt 'Implement the requested change' --title 'Implementation' --idempotency-key implementation-1
opencraft thread show 'opencraft://conversation/v1/server/thread' --turns 2
opencraft thread tell 'opencraft://conversation/v1/server/thread' --message 'Add the agreed validation' --idempotency-key followup-1
opencraft thread output 'opencraft://conversation/v1/server/thread'
opencraft thread operation show '<operation-id>'
opencraft thread input status '<operation-id>'
opencraft thread wait 'opencraft://conversation/v1/server/thread' --timeout 3000
```

Output is JSON. Writes require an explicit idempotency key. After an uncertain response, reuse that key with identical arguments; a changed request is rejected. A queued/submitted receipt does not mean the task succeeded. Short waits return a durable ticket when unsettled; the existing parent notification machinery handles later outcomes.

`list --children` reads Broker parentage across drivers, including hidden children. It returns metadata only, never transcript bodies, and does not start or resume an engine. Pagination scans a bounded page and filters child read permission before returning metadata. Follow `nextCursor` even when a page is empty after authorization filtering; null marks the end. Cursors are bound to the parent. Runtime is the last observed authoritative snapshot, with `observedAt`; it is not inferred from tool completion.

`show` reads bounded user/assistant text. `tell` defaults to queue; steer requires `--delivery native --expected-turn <exact-id>` and never silently falls back to queue. Child results and direct user intervention must be reviewed before issuing follow-ups. A user's stop is intentional: do not automatically retry, replace, or resume that work. Preserve independent work as separate children, and reuse the original conversation for a continuing task.

## Execution ownership and limits

The CLI adds no engine owner, database or task queue. It shares the existing delegation budget, durable tool receipts, input queue and parent notifications. The configured Host negotiates CLI capability independently of other MCP tools. Interrupt delivery remains explicitly unsupported by the current Broker permission contract; it never becomes queue implicitly. Legacy DSH, arbitrary ACP providers, expired delegation recovery, and native tool schema migration are not implied by the command interface.

An input claimed by the Codex Host immediately before an ambiguous transport loss can remain `unknown` and block later input. The CLI does not blindly replay or discard such input. A new idempotency key is not a safe recovery strategy; inspect delivery and the original conversation. This boundary is independent of CLI operation-receipt deduplication.
