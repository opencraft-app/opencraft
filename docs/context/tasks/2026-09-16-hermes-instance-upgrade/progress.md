# Progress

## 2026-09-16

- Read release and Hermes image upgrade contracts.
- Identified selected instance and exact single-instance boundary.
- First local curl wrapper failed before the remote command because nested shell quoting expanded the status marker; no backend upgrade evidence was produced.
- Replacing the wrapper with a generic stdin-only credential executor before retrying.
- Generic executor succeeded; `acli` self-update/bootstrap returned `ACLI_OK`.
- Recorded current backend version 0.21.0 and upgrade command contract. No Hermes backend upgrade has started yet.
- Bundle refresh is current and the supported upgrade checker confirms a version mismatch to target 0.21.3. Ready to start the single-instance backend transaction.
- `upgrade-start --blueprint-id latest` exceeded the public debug-exec gateway timeout and returned 504. Follow-up version/process checks show no upgrade completed or remains running.
- Investigating the current 0.21.0 gateway capability because the user observed a grey New Group action and the source already contains Hosted Rooms code.
- First WebSocket probe was rejected because it omitted the local gateway token; a second probe acquired the token in-process without printing it and returned Hosted Rooms protocol v2 with a running driver.
- Upgrade is no longer justified by the observed grey action; pausing mutation and tracing OpenCraft capability projection instead.
- Direct live probe confirmed Hosted Rooms protocol v2 with a running driver and required methods on 0.21.0.
- Authenticated Profile inventory contains only the root `default` Profile. Source trace confirms the UI requires at least two available Bots before enabling New Group.
- No Hermes upgrade completed; version remains 0.21.0. Stopped the credential executor and removed its temporary script.
