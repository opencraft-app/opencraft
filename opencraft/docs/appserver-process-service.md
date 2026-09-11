# Host process service

The terminal plugin uses AppServer process RPC for all hosts. It does not invoke
Electron PTYs or Agent Turns. The local Host installs HostProcessService alongside
the DSH adapter in the Daemon process; process requests never dispatch to DSH.

## Wire contract

- `process/spawn`: command vector, cwd, env, tty, size and client-generated processHandle; immediate acknowledgement.
- `process/writeStdin`: processHandle and deltaBase64.
- `process/resizePty`: processHandle and size.
- `process/kill`: explicit termination.
- `process/outputDelta`: processHandle, sequence, stream, deltaBase64.
- `process/exited`: processHandle and exitCode.

OpenCraft additions (not claimed to be upstream Codex contracts):

- `process/list`: retained running/exited metadata.
- `process/attach`: processHandle, afterSequence; returns ordered output, phase,
  exitCode, nextSequence and truncated. Sequence is per process, not per connection.

## Ownership

The authenticated Host owns processes and a bounded output ring. A disconnected
socket, unmounted xterm, or disposed client controller does not kill a process.
Explicit tab closure requests kill. Daemon shutdown ends its processes. State is
not persisted across Daemon restart, and does not bypass OS sleep.

The client buffers live notifications during attach, merges replay by sequence,
and resumes only after AppServer initialization. It never automatically respawns
a missing process. The terminal registry keys sessions by host and process handle.
The terminal toolbar shortcut creates a terminal directly. The outlet-owned plus
button opens a type picker, sharing plugin-contributed creation actions with the
empty-panel launcher. Selecting Terminal invokes the same plugin action as the
shortcut; the active tab type never controls which creation actions appear.
Process discovery is available through the protocol; there is no
restore menu or automatic tab discovery after a fresh renderer starts.

Limits: 64 retained sessions, at most 1 MiB base64 replay per session; exited
records are evicted first. Expired output is reported explicitly.

## Deployment scope

Local backend, terminal client and native-module packaging are implemented.
The Hermes/TAT bridge still exposes command/exec; it requires a separate backend
migration to support this contract. There is deliberately no command/exec fallback.
Other hosts must implement the process methods; attach/list and sequenced replay
are additional requirements beyond upstream process execution.

Verification includes real PTY input/resize/exit, observer reattachment, transport
reinitialization, and an authenticated WebSocket replacement with DSH unavailable.
macOS installation and visual validation must be performed on the target Mac.
