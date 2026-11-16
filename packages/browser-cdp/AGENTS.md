# Electron browser automation

This package is shared by local Electron Main and remote Electron Worker.
It must not import a harness, generated AppServer protocol, a renderer or product
configuration. Host identity, page ownership and control authority are supplied
by trusted host composition.

## Layout and ownership

- `src/transport.ts`: command/event port, independent of Electron runtime types.
- `src/electron/`: one connection owner per WebContents, target/session routing,
  initialization, configuration barriers and connection retirement.
- `src/automation/`: isolated observations, bounded snapshots, frame/document
  references, native hit testing, keyboard/pointer input and temporary handles.
  Keep high-level automation outside the connection owner.

Consumers do not attach/detach a debugger independently. Configuration changes
and input use the owner's synchronization barrier. Timeout/abort stops waiting;
it does not prove Chromium cancelled a command. Never replay native input or
detach a shared connection merely because one call timed out. Frame startup must
resume a paused target even when initialization fails or disposal races it.
Initialize the native blank page before creating its connection owner. Callers
provide `validate` guards for page/control identity across asynchronous waits.
Disposal cannot transfer a page to a new owner while old native work is unknown.

## Implementation TODO

- [x] Establish neutral contracts/catalog and preserve AppServer compatibility.
- [x] Implement and test a single CDP owner, bidirectional events, nested target
  setup, configuration ordering, cancellation and retirement.
- [x] Connect existing remote focus, touch and device configuration to the owner.
- [x] Implement document/frame-bound references and native click/fill/press/scroll.
- [x] Replace remote PreviewBridge automation; preserve existing control grants.
- [x] Connect local Main through owned-guest IPC to the same automation code.
- [x] Keep rendering active within host-owned automation calls and release it
  after cancellation/failure; preserve existing capture and media ownership.
- [x] Retain shared drawing leases for viewer-free service calls on existing tabs.
- [x] Capture service screenshots through the shared connection and drawing lease.
- [x] Recover committed logical tabs through the service under the same authority.
- [x] Expose native navigation with document admission and control/cancel fencing.
- [x] Add service-owned logical tab creation with atomic metadata and client synchronization.
- [x] Close committed tabs through shared retirement and control authority;
  preserve uncertain native reservations and remove client projections.
- [x] Exercise Codex `exec --json` through real MCP and packaged Electron/CDP
  with isolated model-response and execution-authority fixtures.
- [x] Supplement CLI acceptance with actual native multi-turn history,
  persisted human input admission, Worker-backed grant resolution and revocation.
- [ ] Verify real Electron behavior and each supported harness; do not mark
  unit-test evidence as end-to-end completion.

See [inventory, sequence and acceptance](../../docs/architecture/browser/automation-migration.md).

## Focused validation

- `OPENCRAFT_CODEX_EXECUTABLE=/path/to/codex npm run smoke:browser-codex-cli`
  validates CLI tool routing, typed image feedback and native close, plus native
  multi-turn domain admission. Model decisions are fixtures; this is not paid-model or
  installed-client acceptance.
- `npm run test:browser-automation`
- `npm run typecheck --workspace @opencraft/browser-core --workspace @opencraft/browser-appserver --workspace @opencraft/browser-cdp`
- `npm run check:boundaries`
- `npm run smoke:browser-cdp-owner` (isolated Electron/profile, synthetic pages;
  proves the connection owner, not the installed app or high-level automation).
- `npm run smoke:browser-cdp-automation`: native actions, references, nested
  cross-site/same-process frames, shadow DOM, affine transforms, zoom and mobile
  page scale. Assert actual target events, not merely successful CDP ACKs.
- `npm run smoke:desktop-browser-cdp`: actual preload, owned webview registry,
  Main IPC and renderer adapter with React-controlled fields and focus takeover.
- `OPENCRAFT_SMOKE_AUTOMATION_ONLY=1 npm run smoke:remote-browser`: packaged
  Worker/gateway/renderer/tool path; explicitly excludes video presentation.
- `npm run smoke:remote-browser-owner-automation`: the same native path through
  the private persistent Owner and viewer-free capability provider/MCP, including
  background creation/close and online client identity/focus preservation, native PNG
  capture, navigation/history and real Worker termination/restart
  recovery with no viewers; execution admission is a fixture in this smoke.

Observations run in isolated worlds without a persistent bridge or DOM markers.
References include host-supplied instance identity, snapshot, native node and
frame loader/context lifetime. Keep up to eight 500-element snapshots. Inspect
again after expiration, node removal, semantic changes or document replacement.
Currently fill supports text inputs, textarea and contenteditable; unsupported
control types and perspective frame transforms fail explicitly. Geometry probes
may repeat; native down/text events never replay. Cleanup releases still run when
document/control guards are lost. Unconfirmed release blocks subsequent writes.

Local native input needs the embedder webview focus path as well as document
focus. The renderer lends that path for writes, cancels on focus/window loss and
restores prior focus only if no takeover occurred. Main owns document leases and
per-operation cancellation. Guests never receive preload or raw CDP access.
