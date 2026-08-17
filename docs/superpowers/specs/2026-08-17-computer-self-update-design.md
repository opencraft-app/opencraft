# Computer self-update design

## Goal

Future Vela Computer releases upgrade without asking a Server user to generate a setup code or rerun an installer.
The remote update service only publishes the expected release for a channel. It does not identify Computers, own
Computer credentials, schedule Agent work, or receive fleet status.

The currently deployed v0.1.50 does not contain an updater and therefore requires one final manual bootstrap to the
first self-updating baseline. The baseline is planned as v0.1.51. A later v0.1.52 release must prove the complete
unattended N-to-N+1 path.

## Service boundary

The update control plane reuses the existing Go binary and OCI image but runs as an independent process and
Kubernetes deployment:

- main platform: `chatserver serve`;
- update service: `chatserver computer-update serve`.

The update deployment has its own ServiceAccount, Secret, PVC, port, liveness/readiness probes and resource limits.
It does not start chat APIs, IM workers, Human APIs, Computer assignment handlers or database migrations. Shared
Ingress provides the hostname/TLS and routes only the update paths to this service.

Initial internal routes:

- `/computer-releases/**` — anonymous read-only Computer channel and artifact access;
- `/ops/computer-updates/**` — internal operations page and mutation API.

The first version has no login screen and no Human/Server role integration. The operations surface is reachable only
through an internal Ingress allowlist, rejects cross-origin requests, exposes no CORS, validates Host/Origin and writes
an audit record for every channel mutation. Server owners and admins have no upgrade controls. A later enterprise SSO
layer can authenticate platform operators without changing the channel or Computer protocol.

## Minimal channel model

The service owns only two named pointers: `stable` and `canary`. Each channel/target record is a small canonical JSON
document persisted under a private state directory using temporary-file write, fsync and atomic rename. A single
replica with a retained PVC is sufficient for the first internal deployment; no new business database or shared
chatserver tables are introduced.

The signed descriptor contains:

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "target": "linux-amd64",
  "sequence": 7,
  "expectedVersion": "v0.1.52",
  "catalogSHA256": "...",
  "issuedAt": "2026-08-17T14:00:00Z"
}
```

Rules:

- channel is exactly `stable` or `canary`;
- target is one of the formally released Computer targets;
- sequence is strictly monotonic for each channel/target;
- expectedVersion must exist in an immutable, independently verified Release Set containing every required target;
- a mutation cannot overwrite or alter an existing Release Set;
- promoting a channel signs and atomically commits descriptors for all required targets as one logical operation;
- the service keeps the previous accepted descriptor for operational rollback of the pointer, but rollback cannot make
  a Computer automatically install a version below its local healthy floor.

Computer reads one anonymous endpoint such as:

`GET /computer-releases/stable/linux-amd64`

The response contains the descriptor, its signature, and short-lived download URLs for the catalog/artifacts. URLs are
transport locations, not trust anchors. They may be generic presigned COS URLs because the release artifacts are not
secrets. The Computer authenticates all downloaded bytes by digest and signature.

## Trust model

There are two distinct Ed25519 trust domains.

### Offline release key

The existing offline release key signs the target manifest. It authenticates version, target, program SHA-256 and
size. Its private key remains on the release machine and is never mounted into the online update service.

### Online channel key

The update service has a separate online key that signs the canonical channel descriptor. The first self-updating
Computer baseline pins the channel public key and the accepted release public key set.

Verification order on Computer:

1. verify canonical channel descriptor with the pinned channel public key;
2. require channel and target to match local configuration;
3. require sequence to be greater than `highestAcceptedSequence` unless the descriptor is byte-identical;
4. reject an expected version below `highestHealthyVersion`;
5. download the Release Catalog and require its SHA-256 to match the descriptor;
6. select the local target and verify the offline release signature over its manifest;
7. verify program SHA-256, size, target and version before staging.

Compromise of the online channel key cannot create an executable trusted by the offline release key. Local monotonic
sequence and healthy-version floors prevent replaying an older signed pointer or silently downgrading the binary.
Availability attacks can delay updates but cannot authorize arbitrary code.

Key rotation is outside the first slice. A future rotation design must overlap old/new public keys and be authorized by
an already trusted key; it must not replace the trust store from an unsigned channel response.

## Computer polling

The Computer updater is independent from Enrollment and Agent Assignment.

- poll once after daemon/platform connectivity is established;
- poll every 15 minutes with a uniform plus/minus ten percent jitter;
- retry network failures with bounded exponential backoff;
- cache only a fully verified descriptor;
- ignore the same version/sequence without side effects;
- never send Computer ID, Server ID, credential, Agent identity or workspace data to the update service.

The current `daemonVersion` and existing platform heartbeat remain the fleet-observation source. The update service does
not receive heartbeat data. The ordinary Computer management UI can display current version from chatserver; the
operations page only displays channel state and audit history, not fleet progress.

## Local update state machine

The first slice supports normal, idle-only upgrades:

`idle -> downloading -> verified -> waiting_for_idle -> installing -> restarting -> healthy`

Failures enter:

`failed -> rollback_installing -> rolled_back`

Urgent deadlines and forced interruption are deferred. The service publishes only an expected version; it does not
send execution commands. A future urgent policy must be a separately signed schema extension.

Downloading and verification may run while work is active. Program replacement requires the exclusive activity gate.

## Activity gate and TAT lessons

The bundled TAT source provides the useful concurrency model:

- executing tasks and TSSH sessions hold a restart-prevention read guard;
- a restart/updater obtains the exclusive write guard only after active work exits.

Vela applies the same model to all process-owned activity. Agent Runtime work, secure terminal sessions and embedded
TAT tasks hold activity leases. The updater marks `waiting_for_idle`, stops admitting new long-running work, then waits
for the exclusive lease. Normal update never kills active work.

The vendored TAT `CheckUpdate` transport and MD5 response are not reused. They are not wired into a complete updater
and are weaker than Vela's signed Release Set.

## Atomic replacement

`vela-computer` remains the only installed binary. The daemon starts a temporary helper mode from the same executable:

`vela-computer upgrade apply --journal ...`

The daemon first stages the verified program on the same filesystem and writes a versioned `upgrade.journal.json` with
current/new version, hashes, paths and phase. After acquiring the activity gate it starts the helper and exits
gracefully. The already-running helper can continue even while the on-disk executable is replaced.

Helper sequence:

1. verify journal ownership, permissions, target and staged program again;
2. wait for the daemon PID to exit;
3. copy the currently running healthy binary/journal into a versioned backup directory;
4. fsync staged files and atomically rename the program into the canonical path;
5. update install journal version/hash without changing Computer identity or credentials;
6. restart through a platform adapter: systemd on Linux, launchd on macOS;
7. wait for a health marker written by the new daemon after local initialization, TAT startup, Assignment reconciliation
   and one accepted platform heartbeat;
8. on timeout or invalid health evidence, restore the previous binary/journal atomically and restart it;
9. retain the last healthy backup and bounded failure evidence; remove older staging data.

Power loss or process death at every journal phase must be recoverable on the next service-manager start. The main
daemon performs startup recovery before starting Agent cells. At no time may the canonical path contain a partial
binary.

## Local durable state

The updater stores only versioned, bounded operational state under the existing Computer state root:

- `update/channel-state.json`: highest accepted sequence per channel/target;
- `update/healthy-version.json`: highest successfully healthy version and program hash;
- `update/upgrade.journal.json`: current transaction and phase;
- `upgrade-backups/<from>-to-<to>/`: previous binary and install journal;
- `update/failures/`: bounded safe error code/timestamps without URLs, tokens or manifest contents.

Existing Computer ID, credential, TAT configuration, Agent workspaces, message cursors and runtime homes are never
recreated or migrated by an upgrade.

## Operations page

The internal page is deliberately small:

- show stable/canary descriptor version, sequence, target coverage, digest, issued time and signature verification;
- list immutable published Release Sets available for promotion;
- promote one verified Release Set to canary or stable;
- show audit history and the previous pointer;
- allow pointer rollback with a warning that Computers never auto-downgrade below their local healthy floor.

It does not list Servers, Computers or Agents, and it does not offer per-Computer commands. Canary qualification is
performed by configuring the selected Computer to poll the canary channel before stable promotion.

## Bootstrap and delivery proof

v0.1.50 is the last manually upgraded release and does not participate in unattended upgrade. Delivery proceeds:

1. deploy the update service and internal operations page;
2. publish v0.1.51 with the pinned trust roots, poller, activity gate, helper and recovery logic;
3. manually upgrade one Linux and one macOS Computer to v0.1.51 using the existing signed install/manual bootstrap;
4. publish v0.1.52 to canary and prove both Computers self-update without setup code or Human interaction;
5. inject bad channel signatures, digest mismatch, wrong target, disk-full, helper crash, daemon health timeout and
   power-loss-at-each-phase faults; every unsafe case must keep or restore a healthy signed binary;
6. promote v0.1.52 to stable only after the canary proof.

## Verification gates

- canonical descriptor and signature golden tests;
- channel sequence monotonicity, atomic persistence and concurrent mutation tests;
- strict path/target validation, no CORS and Host/Origin rejection tests;
- channel-key and release-key separation tests;
- Computer poll jitter/backoff/cache tests;
- replay, downgrade, wrong-channel, wrong-target and bad-signature rejection tests;
- program hash/size and offline manifest verification tests;
- activity-gate tests covering Agent Runtime, terminal and TAT task leases;
- updater journal crash matrix for every transition;
- Linux systemd and macOS launchd N/N+1 success and rollback integration tests;
- live v0.1.51 -> v0.1.52 canary with no setup command, preserved Computer identity/workspace and accepted heartbeat;
- full Backend, Agent, race, generated-contract, migration-lock and credential-scan gates.

The feature is not complete merely because the channel page changes version or the program downloads. Completion
requires a real old Computer to become the new healthy version, report through existing heartbeat and preserve its
identity and workload state, plus a real failure that restores the previous healthy binary.
