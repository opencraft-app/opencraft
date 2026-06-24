# Electron local velad runtime

This folder owns the Electron host lifecycle for the local `velad` process:
path resolution, logging, startup, structured ready parsing, runtime diagnostics,
and graceful shutdown.

It is host-only code. Do not import React renderer code or
`packages/vela-desktop-shell` here. The renderer should only see the existing
desktop bootstrap shape: `starting`, `ready`, or `failed`.
