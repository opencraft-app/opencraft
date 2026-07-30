# debug/exec TAT PTY command stream

## Goal

Add an opt-in TAT backend to `POST /v1/instances/{id}/debug/exec` without
changing the existing envd behavior. The TAT backend must execute commands
through `PtyExecCmdStream`; it must not use TAT `RunCommand` polling or emulate
command execution through `PtyInput`.

## API contract

The request accepts:

```json
{
  "command": "acli status",
  "run_as_user": "agentuser",
  "execution_backend": "tat"
}
```

- An absent `execution_backend` keeps the current envd implementation.
- `execution_backend=tat` selects TAT PTY command streaming.
- Other values are rejected as invalid input.
- TAT continues to allow only the existing `agentuser` execution identity.

The existing JSON and SSE response shapes remain unchanged. TAT PTY provides a
combined output stream, so TAT chunks are exposed as `stdout`; `stderr` remains
empty.

## Execution flow

CTL requests an internal command stream from sandbox. Sandbox owns the Tencent
Cloud session bootstrap and connects to the TAT forward WebSocket:

1. `POST /internal/sandboxes/{sandboxID}/tat/exec-stream`
2. Sandbox calls Tencent Cloud `StartSession`
3. Sandbox opens the fixed regional TAT forward WebSocket
4. WebSocket `SessionAuth`
5. `PtyStart` with `Username=agentuser` and
   `WorkingDirectory=/home/agentuser`
6. BSON `PtyExecCmdStream` with a per-command `CustomData` correlation key
7. Receive BSON command chunks and relay ordered NDJSON events to CTL
8. `PtyStop` and close the WebSocket

Each HTTP request owns one TAT session. Sessions are not shared between
commands.

The exec-stream endpoint is internal and never returns `ownerUin`, `loginUin`,
`appId`, `sessionId`, or `wsUrl`. Those values remain inside sandbox process
memory. Sandbox constructs the WebSocket URL from its validated Tencent region;
it never dials a URL supplied by CTL or a frontend caller.

The endpoint is reachable only through the cluster-internal sandbox service.
Per the current deployment boundary, it does not add a second service-to-service
credential. Browser authentication and instance ownership remain enforced by
CTL before this route is called.

## Sandbox stream contract

Request:

```json
{
  "command": "acli status",
  "username": "agentuser",
  "working_directory": "/home/agentuser",
  "timeout_seconds": 120
}
```

Sandbox accepts only the fixed username and working directory above.
`timeout_seconds` is clamped to 1 through 300 seconds.

A successful stream starts with HTTP 200 and
`Content-Type: application/x-ndjson`. Each line is one JSON event:

```json
{"type":"started","execution_id":"pty:abcd1234"}
{"type":"output","execution_id":"pty:abcd1234","index":0,"chunk":"hello\n"}
{"type":"finished","execution_id":"pty:abcd1234","status":"SUCCESS","exit_code":0}
```

The event types are:

- `started`: emitted after `PtyReady` and before sending
  `PtyExecCmdStream`.
- `output`: ordered UTF-8 text from the combined PTY output. There are no
  separate stdout and stderr events.
- `finished`: the only successful terminal event. Status is `SUCCESS` for exit
  code zero and `FAILED` otherwise.
- `error`: terminal protocol/runtime failure after streaming has started, with
  `code` equal to `TIMEOUT`, `CANCELED`, or `PROTOCOL_ERROR`, plus a bounded
  non-sensitive `message`.

Failures before the first event return a non-2xx JSON error. Failures after the
first event emit one `error` line and close the response. No control or
keepalive lines are part of this protocol.

## Streaming and completion

`PtyExecCmdStream` chunks are keyed by `CustomData` and contain `Index`, `Data`,
`IsLast`, and `ExitCode`.

- Buffer out-of-order chunks.
- Emit only the contiguous sequence beginning at the next expected index.
- Preserve incomplete UTF-8 bytes between chunks before emitting SSE text.
- Completion requires both the final chunk and every index through the final
  index.
- Exit code zero maps to `SUCCESS`; any other exit code maps to `FAILED`.
- Protocol errors, command timeout, context cancellation, and missing chunks
  fail the command.
- Client cancellation closes the WebSocket and best-effort sends `PtyStop`.
- The WebSocket is always closed with `defer`, including partial handshake and
  protocol failures.
- `PtyStart.MaxIdleTime` and the command timeout are bounded by the HTTP request
  deadline. A session cannot outlive its owning request.
- Sandbox permits at most 1 MiB of not-yet-emitted out-of-order data. Exceeding
  the bound is a protocol error.
- CTL streams ordered output without an aggregate cap, matching existing SSE
  behavior, but retains at most 128 KiB for the final JSON/`finished.response`
  payload, matching the existing envd path.

The JSON path uses the same stream executor but only returns after completion.
The SSE path forwards each ordered decoded chunk immediately.

CTL mapping is deterministic:

- `started` becomes the existing outward `started` SSE event.
- `output` becomes outward `stdout`; TAT `stderr` remains empty.
- `finished` becomes outward `finished`.
- Sandbox `TIMEOUT` maps to `ErrDebugExecTimeout` and final status `TIMEOUT`.
- Other sandbox errors map to `ErrDebugExecFailed` and final status `FAILED`.
- An error before outward SSE starts is returned as the existing HTTP error.
- An error after outward SSE starts produces the existing outward terminal
  `finished` response with failure details.
- Browser/client cancellation cancels the CTL-to-sandbox request; no additional
  outward event is attempted after the browser connection is gone.

## Ownership

- `sandbox/internal/provider`: session bootstrap, WebSocket/BSON protocol,
  ordered command stream.
- `sandbox/api-gin`: authenticated internal NDJSON exec-stream endpoint.
- `ctl/pkg/adapter/sandbox`: consume the sandbox NDJSON command stream.
- `ctl/pkg/instance`: backend selection and mapping into existing debug command
  responses/events.
- `ctl/main/api`: request field propagation.
- `frontend`: global builds send `execution_backend: "tat"`; China builds omit
  the field and keep the envd backend.

No layer logs raw command text, command output, WebSocket URLs, cloud account
identifiers, or full session identifiers. Errors expose protocol stage and
request correlation only.

## Verification

- Sandbox provider tests cover auth, ready, BSON command request, out-of-order
  chunks, non-zero exit, timeout, and cancellation.
- Sandbox API and CTL adapter tests cover NDJSON streaming and cancellation.
- Instance tests prove TAT selection bypasses envd and both JSON/SSE preserve
  the current response contract.
- API tests cover propagation and invalid backend values.
- Frontend tests verify both normal and SSE requests include the TAT backend.
