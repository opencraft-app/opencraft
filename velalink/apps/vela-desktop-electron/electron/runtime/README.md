# Electron local velad runtime

This folder owns the Electron host lifecycle for the local `velad` process:
path resolution, logging, startup, structured ready parsing, runtime diagnostics,
graceful shutdown, and host process environment preparation.

The runtime manager may emit local OpenTelemetry spans through
`packages/vela-observability-client`. That package is host-safe and only exports
to the local `velad` OTLP/HTTP JSON endpoint advertised by `velad.ready`.
Runtime HTTP calls use the manager's injected `fetchImpl` or the local
`resolveRuntimeFetch()` fallback; do not reintroduce bare global `fetch` in this
folder.

macOS/Linux desktop launches can miss the user's login shell `PATH`. The runtime
host imports that shell environment before spawning bundled `velad`, so tools
that `velad` launches, such as `codex`, resolve the same way they do in a
terminal. Do not encode Codex CLI compatibility flags here; use environment and
path resolution so the installed, current CLI is selected.

It is host-only code. Do not import React renderer code or
`packages/vela-desktop-shell` here. The renderer should only see the existing
desktop bootstrap shape: `starting`, `ready`, or `failed`.
