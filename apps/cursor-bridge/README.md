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
  skipping native cancellation on a removal error. Confirmed Stop permits a new
  explicit turn; uncertain cancellation retains a write fence. A failed close
  keeps the session owned and reports that it remains open for cleanup. A local
  removal error after confirmed native completion is explicitly rejected; files
  remain owned for retry. After confirmed Stop, Worker termination is the local
  close boundary; SDK disposal is best effort, and failed termination can retry.

Input is `{text, attachments?: [{data: "<base64>"}]}` (64 KiB encoded total,
16 attachments). Generated private local paths are passed as text; this is not
rich SDK attachment support. Each input owns its directory through run completion,
rejection, withdrawal or Stop. Cleanup joins conversion to prevent late writes.
Slashes, image fields and unknown input fields are rejected.

The shared assembler owns canonical events and existing AppServer projection.
No CLI/history/resume/usage/reasoning capability is claimed. The smoke's process
test backend does not prove production sandbox isolation. Reproduction:

```sh
npm run build --workspace @opencraft/cursor-bridge
node --import tsx scripts/smoke/agent-bridge/p5-cursor-host.ts <cheapest-available-sdk-model-id>
```

See [validation](VALIDATION.md) and [CLI/hook feasibility](../../design/agent-bridge/p5-cursor-cli-feasibility.md).

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
