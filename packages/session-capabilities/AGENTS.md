# Session capabilities

Trusted composition supplies server/thread/execution identity. Providers retain
domain authorization and effect receipts; transport adapters do not select an
owner from model arguments or replay an uncertain external action.

`CapabilityResult` distinguishes text and inline images. `src/content.ts` owns
bounded MCP wire conversion in both directions; it never fetches image URLs or
expands resources. Unsupported content is an explicit error. Formatting errors
after a received result must not reconnect/replay the completed call.

- [x] Preserve typed text/image results through the shared MCP gateway and remote
  Host attachment; preserve order and failure status.
- [x] Reject late provider output after caller cancellation.
- [x] Register the browser provider from trusted application composition, with
  live execution admission, account/Host/Scope mapping and per-call identity.
- [x] Assign a server-generated identity to each admitted MCP invocation while
  preserving the original execution context. JSON-RPC IDs are client-local and
  must not become effect-receipt identities across clients. They grant no authority.
- [x] Attach a core-resolved `context` (Host, verified human Actor, active lease)
  to every provider session; caller-supplied values are discarded.
- [ ] Verify cancellation and effect receipts across every harness integration.

See [browser migration](../../docs/architecture/browser/automation-migration.md).

Stateless MCP does not promise external-effect replay by JSON-RPC request ID.
Each newly received call is a distinct invocation; uncertain results require
domain inspection, never an automatic HTTP retry. A provider's internal recovery
keeps the already admitted call context and its stable domain receipt.
