# Class names and engine ownership

OpenCraft-owned Host policy, metadata and storage use `OpenCraft` class names.
Classes that implement a specific execution engine retain its name. A source
rename does not introduce support for another engine or migrate stored data.

## OpenCraft-owned classes

| Class | Responsibility |
| --- | --- |
| [OpenCraftHostQueue](../../apps/opencraft-daemon/src/opencraft-host-queue.ts) | OpenCraft owns durable input admission, ordering, delivery state and recovery. Its explicit native-queue importer still reads the legacy Codex format. |
| [OpenCraftHostStateDatabase](../../apps/opencraft-daemon/src/opencraft-host-state-database.ts) | OpenCraft owns migration and transactions for queue, sender provenance, Bot metadata and the durable catalog. |
| [OpenCraftMessageAttachments](../../apps/opencraft-daemon/src/opencraft-message-attachments.ts) | OpenCraft stores display references separately from native engine input. |
| [OpenCraftTokenUsageLedger](../../apps/opencraft-daemon/src/token-usage-ledger.ts) | OpenCraft owns metering facts, allocation, recovery checkpoints and query authority; engine collectors supply verified source facts. Native-counter and rollout state remain explicit source records. |
| [OpenCraftQueueRpcError](../../apps/opencraft-daemon/src/codex-engine-adapter.ts) | This local error carries OpenCraft queue admission and dispatch failures. |
| [OpenCraftMessageSenders](../../apps/opencraft-daemon/src/opencraft-message-senders.ts) | OpenCraft owns sender provenance; all internal consumers use this shared implementation directly. |
| [`SshConnectionError`](../../apps/opencraft-daemon/src/ssh-connection.ts) | Shared SSH trust/authentication and SFTP failure classification, carrying stable codes and retryability. The native transport adds its own proxy-failure classification. |

`SshConnectionOptions`, endpoint validation and the password helper live in
`ssh-connection.ts`, shared by SFTP, managed connection storage and the native
transport. File transfer neither constructs an execution adapter nor validates
its executable/home/socket settings. Missing remote files or an unavailable SFTP
subsystem are transfer failures, never a request to install an execution engine.
Codex proxy commands, WebSocket framing and `SSH_CODEX_UNAVAILABLE` stay in the
native transport; saved connection and credential formats are unchanged.

The daemon workspace is private. These source files are internal implementation
entries, not Extension API V1. All in-repository imports, scripts and tests move
with their classes; no second implementation or old class-name alias remains.
Message metadata consumers import the canonical thread projection helpers
described in the [internal naming contract](internal-naming.md).

The private account-pool workspace owns `AccountCredentialRefreshManager` and
`AccountCredentialRefreshReason`: they coordinate expiry checks, single-flight
refresh and credential replacement. Provider-specific renewal is injected by
`createManagedCodexRefresh`. The pool currently supports Codex accounts only;
this naming does not add another provider.

## Engine-specific classes retained

| Class | Engine-specific responsibility |
| --- | --- |
| `CodexEngineAdapter` | Adapts native Codex execution and account methods to OpenCraft Host capabilities. |
| `CodexThreadTitles` | Uses Codex ephemeral Threads, native configuration, sandbox policy and Turn notifications for title inference. |
| `CodexThreadPins` | Adapts the native reserved section ID and thread-section methods. |
| `CodexNativeCoreTransport` | Opens native Codex connections through the independent core. |
| `CodexCoreSocket` | Connects to the Codex core socket and its connection protocol. |
| `CodexCoreBridge` | Bridges logical clients to the Codex core service. |
| `CodexCoreReadIsolation` | Opens bounded native Codex core sockets for stateless history reads, separately from subscriptions and execution. |
| `CodexTokenUsageRuntime` | Collects Codex native events, UUIDv7 Turn identity and rollout files from codexHome. |
| `SshCodexTransport` | Runs the actual Codex app-server proxy and tunnels its protocol. |
| `CodexAccountsService` | Client service for Codex account and device-login RPCs. |
| `CodexDeviceLoginService` | Implements native Codex/ChatGPT device authorization and credential import. |
| `CodexSubscriptionService` | Reads Codex subscription and rate-limit provider responses. |
| `CodexAccountService` | Owns Codex-specific account operations and credentials. |
| `CodexCoreControlClient` | Sends control requests to the independent Codex core. |
| `CodexAccountPoolProxy` | Proxies Codex provider requests and account quota/affinity policy. |

## Stable external and persisted identities

The cleanup changes owned symbols, live table names and fresh-store paths. It preserves:

- Existing `codex-host-queue.sqlite` and `codex-message-attachments.sqlite` file paths as explicit compatibility inputs,
  and all published migration names, versions and SQL checksums. Host-state v13
  and attachment v2 migrate active tables and indices to `opencraft_*`; see
  [the storage upgrade contract](../sqlite-lifecycle.md#owned-live-table-names).
- Host-state v14 also preserves historical Bot records under `opencraft_bot_*`;
  the original table spelling remains only in immutable migrations and upgrade
  inputs. Old managed readers reject v14; old unguarded writers must stay stopped.
- Native Codex queue import format, delivery reconciliation and source records.
- Host IDs, environment variables, capability/RPC identifiers and generated
  Codex protocol types.
- Account credentials, installation state and conversation identities.

Current active storage names describe OpenCraft ownership. New stores use `opencraft-host-state.sqlite` and `opencraft-message-attachments.sqlite`.
Existing old files stay in place on ordinary open. The separate
[offline maintenance command](../sqlite-lifecycle.md#两个-host-自有文件的离线改名)
can relocate their physical names after all owners stop. These legacy names are
not native engine contracts; code delivery does not mean installed data moved.
The engine-specific classes above describe actual integrations. Future generic
implementations should obtain their own owner and verified capability contract;
renaming a native adapter alone cannot establish engine independence.

Owned CSS, model discriminators, projection helpers and compatibility inputs
follow the [internal naming contract](internal-naming.md).
