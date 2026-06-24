# velad.local.v1

`velad.local.v1` is the local host-daemon runtime contract for running `velad`
on one machine. It covers process startup, ready reporting, runtime diagnostics,
and graceful shutdown.

`velachat.v1` remains the business HTTP API contract under `/api/v1`.

The default runtime is local. There is no separate `standalone`, `managed`, or
`embedded` mode in this daemon. A local `velad` can be started by Electron,
systemd, a script, or a developer shell.
