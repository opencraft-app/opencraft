# Cursor SDK bridge (P5, opt-in)

This standalone Host provider uses `@cursor/sdk` 1.0.32. Engine defaults and
Hermes are unchanged. Build with `npm run build --workspace @opencraft/cursor-bridge`;
register `dist/main.mjs` with `CURSOR_DECLARATION` as a pinned Host generation.
Keep `dist/sdk-worker.mjs` beside it: the main bundle verifies the build-time
worker digest. Install the locked SDK alongside the build; it stays external.

## API key setup

Cursor CLI login and SDK API-key authentication are separate. Supply your own
key through the existing provider credential configuration or the bridge launch
environment; the bridge never writes a key into source, protocol frames or logs.

1. Sign in to [Cursor Dashboard → API Keys](https://cursor.com/dashboard/api).
2. Create a **User API key**. Copy it into `CURSOR_API_KEY` in the Cursor bridge's
   launch environment on the Engine Host (`generation.launch.env`), using your
   existing private environment/credential configuration.
3. Alternatively, use the Cursor SDK's interactive `Cursor.auth.login()` yourself;
   its existing SDK credential store is read by the SDK. The adapter does not
   initiate login, create a key, read CLI secrets, or copy credentials.
4. Start the generation and create the session. A missing/unusable key returns
   a typed `auth` error with the dashboard URL and `CURSOR_API_KEY` instructions,
   before an agent is created. A blank environment value is not a credential.

The [official SDK guide](https://cursor.com/docs/sdk/typescript) describes user
and service-account API keys and the SDK credential store. Team Admin API keys
are not supported by that guide.

## Behavior and lifecycle

Create with explicit absolute `cwd` and private `stateDirectory`, an explicit
`model`, and `permissionMode: "full"`. Only shell tools are enabled in P5. Other
permission modes are refused. SDK sandboxing is explicitly disabled for full
mode; containment belongs to the Host-selected backend. SDK runtime and its
public `JsonlLocalAgentStore` run in a dedicated Worker, off the Host/bridge
network loops. Transport/agent auto-retries are disabled. The adapter does not
spawn another uncontained runner; native execution inherits the Host sandbox.

`turn/start {input}` returns a bridge turn key. `turn/steer` requires its
`expectedTurnId`, stable `inputId/clientRequestId`, and input. Only native-inject
is declared. Queue, interrupt and queue fallback policies are refused.

- `complete_delivered` records **SDK delivery/admission only**, with native run
  id. Local SDK user/history echo is ignored as context evidence.
- `revert_to_followup` becomes `input.outcome: rejected`, with “The message was
  not inserted into the current turn.” No followup is sent automatically.
- One unresolved steer is permitted. SDK rejection without a definitive result,
  Worker loss, unrecognized outcomes and a 30s deadline retain unknown and fence
  further writes. Query the existing input; a new command id is not reconciliation.
- Stop checks a supplied expectedTurnId/turnId against the active turn; an
  unscoped Stop targets the current active run. It cleans attachments before
  waiting for SDK send/cancel acknowledgement, and retries cleanup without
  skipping native cancellation on a removal error. It cancels a dispatched SDK
  run while the Turn-open acknowledgement is pending. Stop before dispatch
  rejects the start. A dispatched run still reports its open and interrupted
  close when Stop occurs before the SDK returns its handle. Stop and session
  close join the same cancellation and cleanup. Confirmed Stop permits a new explicit
  turn. Uncertain cancellation retains a write fence. A failed close
  keeps the session owned and reports that it remains open for cleanup. A local
  removal error after confirmed native completion is explicitly rejected; files
  remain owned for retry. After confirmed Stop, Worker termination is the local
  close boundary. The SDK gets up to three seconds for best-effort disposal
  before the Bridge terminates the Worker. Failed Worker termination can retry.

Input is `{text, attachments?: [{data: "<base64>"}]}` (64 KiB encoded total,
16 attachments). Generated private local paths are passed as text; this is not
rich SDK attachment support. Each input owns its directory through run completion,
rejection, withdrawal or Stop. Cleanup joins conversion to prevent late writes.
A local attachment preparation failure rejects the start before SDK dispatch.
After cleanup, the session can accept an explicit retry. A lost SDK send
receipt keeps the outcome unknown and fences further writes.
SDK terminal confirmation controls normal cleanup independently of callback
delivery and stream drain. Normal completion drains the final messages before
closing the Turn. After an explicit Stop confirms native completion, the
Bridge drops unread output and asks the SDK iterator to return. The Stop can
finish while an outstanding SDK read remains pending. A stream failure fences
further writes and keeps run-owned files
until the SDK confirms terminal state or an explicit Stop or close cleans up.
The Worker and adapter keep one run handle per session. Starting the next Turn
releases the previous handle, and operations must target the current run.
Steer rechecks the originating run after admission and attachment preparation.
Slashes, image fields and unknown input fields are rejected.

Closing a session fences further mutations and joins concurrent close requests.
Local SDK disposal is retained if the Host rejects the final callback, so a
retry can finish reporting closure. A lost stdio pipe stops callback delivery.
Delta acknowledgements are ordered within each session. A pending
acknowledgement in one session leaves the others free to send their deltas.
The Host still owns durable callback ordering.
The first shutdown trigger owns process exit and gives local cleanup up to
ten seconds. If cleanup is still pending, stdio exits with failure and the
Host retains ownership of sandbox reclamation.

Creation admits input after the Host acknowledges the session identity.
Shutdown cancels provisional credential, model catalog, and session Workers.
It joins their cleanup, including disposal for any agent already returned.
Late results cannot publish a model list or a ready session after shutdown.
Concurrent model lists share a single lookup for this Bridge's credentials.
The credential and catalog queries have a combined ten-second budget. A
timeout closes the Worker and allows the next request to try again.

The shared assembler owns canonical events and existing AppServer projection.
No CLI/history/resume/usage/reasoning capability is claimed. The smoke's process
test backend does not prove production sandbox isolation. Reproduction:

```sh
npm run build --workspace @opencraft/cursor-bridge
node --import tsx scripts/smoke/agent-bridge/p5-cursor-host.ts <cheapest-available-sdk-model-id>
```

See [Design decisions and known limits](#design-decisions-and-known-limits) and [CLI/hook feasibility](../../design/agent-bridge/p5-cursor-cli-feasibility.md).

## Source and license boundary

User-owned steer/lifecycle changes were checked at cursor-acp commits `afe6dbd`,
`0cf8152`, `b65bc59`, `03176ce`, `1fc1064` (the approved user identity). This ports
their run.steer outcome handling and cancellation/attachment ownership into the
Host contract. The latest user decision rejects revert rather than queuing it.
The upstream ACP runner, history writer and permission retry loop are not copied;
transport, Worker adapter and translator are independent implementations.

The cursor-acp checkout is Apache-2.0 with upstream copyright/NOTICE; that license
does not cover the SDK. The SDK's package license is `SEE LICENSE IN LICENSE.md`,
Anysphere copyright, subject to [Cursor Terms](https://cursor.com/terms-of-service).
It is called through the published API, remains unmodified and external, and
retains its notices in the dependency. No SDK source is patched, relicensed or
vendored into the generated bridge bundle.

## Design decisions and known limits

Carried over from the retired validation ledgers; evidence runs and review logs live in Git history.

### P5: Self-introduced decisions

1. A standalone app avoids shared ACP/P6 changes. The published SDK is fixed at
   1.0.32 and external; its proprietary terms are preserved. The upstream runner,
   history writer and approval retry loop are independently replaced, not copied.
2. Only native-inject is declared. Revert is a definitive rejection with a plain
   explanation. No platform next-turn queue, implicit interrupt or retry loop.
3. P5 requires explicit full permission mode, shell tools, model, workspace and
   private stateDirectory. The SDK sandbox is disabled for full mode; the Host
   backend owns containment. No history/resume/usage/CLI/reasoning claim.
4. SDK runtime/storage run in a Worker, whose digest is checked by the main
   artifact. The public JsonlLocalAgentStore keeps vendor storage off network loops.
5. Attachments are bounded base64 inputs converted to generated private local
   paths (64 KiB encoded total, 16 files), not rich SDK attachments. Stop removes
   them before waiting for a possibly hanging SDK send/cancel.
6. One unresolved steer, a 30s deadline and unknown fencing prevent replay.
   Confirmed Stop permits a new explicit turn; uncertain Stop stays fenced. Missing credentials fail
   before creating an agent and link to API Keys and bridge launch configuration.
7. Suite execution removes only exported BASH_FUNC_* environment entries: existing
   fixtures pass all process.env into the strict sandbox validator. No source,
   dependency, sandbox policy or baseline is changed to bypass that validation.

8. Once native Stop is confirmed, Worker termination owns local close completion.
   SDK disposal is best effort; failed Worker termination stays retryable. Failed
   attachment disposal retains session custody and refuses reuse until cleaned.
