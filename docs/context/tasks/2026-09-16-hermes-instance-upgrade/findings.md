# Findings

- Reference Hermes is version `0.21.3`, commit `3c3ab69abb9b08683b5eb15b4e2b8be1198c875f`.
- Hosted Rooms advertise capability through `groups.capabilities`; the driver must be running, not merely compiled in.
- The current repository image trigger last requests a Hermes 0.21.0 rebuild, while runtime image builds otherwise resolve COS `latest.json`.
- The user narrowed authorization to one instance; image/pool/region operations are excluded.
- Selected instance reports `runtime_version=0.21.0`; `hermes --version` confirms Hermes Agent 0.21.0.
- Hosted Rooms source file is present in 0.21.0, so version alone is not proof that the gateway exposes a running driver.
- Updated `acli` is healthy. `upgrade-start` requires a blueprint ID (or explicit COS/display version emergency pair); `upgrade-check` requires an explicit target semver.
- `acli bundle-update` is already current at bundle `2026.09.04-4` / specs `1.1.26`.
- `acli backend upgrade-check --target-version 0.21.3` authoritatively reports `NEEDS_UPGRADE`, current 0.21.0 and target 0.21.3.
- The first `upgrade-start` HTTP request ended in a gateway 504. A read-only audit proves Hermes remains 0.21.0 and no upgrade process survived, so no successful/unknown background upgrade is active.
- The existing 0.21.0 gateway process is running and listens on loopback port 9119; Hosted Rooms source code is present, so capability negotiation must be inspected before attributing the grey UI solely to version.
- Direct authenticated JSON-RPC against the live gateway proves Hosted Rooms protocol v2, `driver=true`, and every OpenCraft-required local method is already present on Hermes 0.21.0.
- `persistent_process=false` and room-link secret unavailability describe cross-install peer linking; OpenCraft's current same-gateway group gate does not require either field.
- Therefore the grey New Group action is downstream of Hermes itself: Bridge/Host/UI capability propagation or selected-host state.
- Live capability negotiation is healthy; the selected instance already satisfies OpenCraft's `groupConversations` gate on Hermes 0.21.0.
- The instance has exactly one Hermes Profile (`default`). OpenCraft intentionally enables New Group only when the Host advertises group topology and at least two Bot directory entries are available.
- The grey New Group action is therefore expected roster validation, not a Hosted Rooms version failure.
