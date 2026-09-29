# OpenCraft disconnect recovery

## Goal

Make a mobile Web client recover deterministically after a short network loss while a process-owned AppServer continues running.

## Ownership and invariants

- The daemon owns the physical AppServer lifetime; a Renderer owns only a logical claim.
- A half-open browser WebSocket must eventually become a terminal transport state so the existing Workbench reconnect state machine can run.
- A replacement logical client must initialize and resume each resident Thread before it becomes authoritative.
- Diagnostics may contain connection, request, and Thread identifiers, but never prompt, credential, or response payloads.

## Changes

- Add native WebSocket ping/pong liveness to the Web host.
- Add a bounded browser AppHost handshake watchdog.
- Record logical initialize and Thread resume lifecycle diagnostics in the Codex Host adapter.

## Verification

- Browser AppHost transport unit tests, including a stalled handshake.
- Headless Web server tests, including a simulated peer that stops answering Ping frames.
- Codex Engine adapter tests and type checks.

## Evidence

- Focused protocol/runtime suite: 72 tests passed across AppHost ownership,
  browser lease renewal, Session history reconciliation, Codex logical routing,
  and the headless server.
- Workbench Web and OpenCraft Daemon TypeScript checks passed.
- Headless package smoke passed for build `20260926054956-409412c8dd8f`.
- The new release is staged at
  `/opt/opencraft-server/releases/20260926054956-409412c8dd8f`; the current
  service still points to `20260926050103-cfaff2d670a4` until a health-checked
  cutover.
- A delayed, health-checked cutover is scheduled. It verifies both health and
  build identity and atomically restores `20260926050103-cfaff2d670a4` if the
  new service does not become healthy.
