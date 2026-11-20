# Personal assistant runtime

The runtime owns assistant work, memory and message ledgers. Platform claims and Actor/lease authority remain with the shared Core. Source integration does not authorize deployment, automatic activation, model use or cloud provisioning.

- Domain has no I/O; application depends on domain/ports, never concrete adapters/runtime. Runtime assembles owners and holds only temporary scheduling resources.
- WorkService owns work/revision and active execution; ExecutionLedger owns immutable snapshots/native bindings/reports; Completion/Outcome own verified completion and delivery. Accepted input, model completion, delivery acceptance and user receipt are distinct facts.
- Pi/Codex retain native checkpoint ownership and the engine captured by each execution. Do not invent a second native task graph, replay unknown external effects, overwrite frozen history or silently switch engines.
- Memory files own facts; SQLite is their recoverable index plus business ledgers. Keep commit recovery, tombstones, original grants and explicit project membership. Models propose, owners validate/CAS; content never grants authority.
- History owns original messages; derived context retains bounded source references and cannot change work or permissions. Skills grant no tools. Credentials never enter user history, checkpoints, telemetry or model-visible diagnostics.
- Host integration uses an isolated child process and bounded private protocol; do not move synchronous SQLite/file I/O onto a network event loop. Shutdown stops ingress/coordinators and reaps native processes before closing storage and releasing locks.
- Fixture tests use isolated profiles and synthetic credentials. Never inherit shared machine/model credentials. Native loopback protocol tests are not real-model quality or external-service acceptance.
- Keep the full existing regression suite, migration checks, crash/recovery and authority checks. No deployment or private evaluation archives belong in this public candidate.
