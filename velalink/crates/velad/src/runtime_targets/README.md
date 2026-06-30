# velad runtime targets

This folder owns the local `velad` runtime-target control plane.

Boundaries:

- `Node` is saved configuration. SSH credentials are referenced by `secret_ref`
  and stored in the local OS keyring, never in ordinary SQLite settings.
- `RuntimeTarget` is a connection-state projection derived from local runtime
  state plus saved nodes.
- `RuntimeTargetManager` owns active target handles and state projection.
- `ssh_transport.rs` owns the native russh connector: password SSH auth, SFTP
  artifact upload, remote `velad` launch, ready-file handshake, local loopback
  tunnel, and best-effort remote shutdown.

Renderer and Electron code must not import SSH logic, see passwords, or build
remote URLs. They should call the local velad API only.
