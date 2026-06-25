# velad.local.v1

`velad.local.v1` is the local host-daemon runtime contract for running `velad`
on one machine. It covers process startup, ready reporting, runtime diagnostics,
and graceful shutdown.

`velachat.v1` remains the business HTTP API contract under `/api/v1`.

`otlp.http.json` is the local observability ingestion protocol. The OTLP
receiver lives at `/v1/traces` and `/v1/logs`; local product queries live under
`/api/v1/observability/*`.

The default runtime is local. There is no separate `standalone`, `managed`, or
`embedded` mode in this daemon. A local `velad` can be started by Electron,
systemd, a script, or a developer shell.
