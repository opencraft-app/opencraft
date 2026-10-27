# Read-only full upgrade inspection v1

P2a provides a Linux/systemd observer and a pure advisory planner. It does not
install, stage, prepare, activate, fence, restart, restore, retire or change any
owner. The output is local administrator diagnostics, not a browser response:
paths, unit names, environment **key names** and machine identities remain local.
The P2d Settings page consumes the authorized agent projection described in
[upgrade control](full-upgrade-agent.md#settings-projection-and-official-web-children-p2d),
rather than exposing this raw object. The standalone inspection introduces no UI text.

The signed server archive includes `runtime/upgrade-inspect.mjs`. Run it with the
same supported Node ABI as the target release, using the deployment's fixed Node
binary. The probe's Node and every observed Node owner are reported separately. Owner version/ABI is known only when its kernel executable identity matches the trusted probe interpreter; other binaries remain unknown. The observer never executes an owner binary to obtain metadata.
A product may embed its profile at composition; otherwise supply `--profile`:

```sh
/path/to/fixed/node /path/to/current/package/runtime/upgrade-inspect.mjs \
  --profile /path/to/local-profile.json --target /path/to/fixed/target/package
```

Without `--target`, only inventory is collected. `--target` must be an immutable
local package root obtained through the existing official release channel; this
command never downloads a target or follows a moving tag. Product trust keys are
baked into the package by the existing full-release producer. Source consumers
must supply trusted keys explicitly to `inspect`/`createPlan`. Target signature,
product, channel, expiry, revocation, platform, sequence and collision checks reuse
`acceptManifest`, without writing its returned replay watermark. Replay state uses the same strict parser as the official updater. Missing, invalid or unreadable current state remains unknown; only observed valid watermarks can verify current sequence/revocation authentication. Do not select a
new trust root from downloaded target contents.

## Wire output

The JSON envelope is `{inventory, plan}`; `plan` is null without a target. Unknown
major versions are rejected. Exported entrypoints are `collectInventory(profile)`,
`inspect({profile,targetRoot,trust})`, `createPlan({inventory,manifestBytes,signature,
trust,now})` and `checkPlanExpectations(plan,inventory,manifestBytes)`.

Inventory has `schemaVersion:1`, `kind:"opencraft.upgrade-inventory"`,
`mode:"read-only"`, `consistency:"component-snapshot"`, `startedAt`, `completedAt`
and per-owner `samples[].sampledAt`. It is **not** a cross-owner atomic snapshot.
The identity fields covered by `fingerprint` are:

| Field | Meaning |
| --- | --- |
| `product/channel/profile/platform/arch/bootId/adapterProfileSha256/system/machineIdentitySha256` | Deployment selection and boot; the product supplies explicit unit-role mappings, never credentials |
| `owners[]` | Stable ownerId, role and payload-role aliases, management, status, standalone presence scope and unknown embedded presence; unit observations, capabilities and retained-reference coverage |
| `owners[].units[]` | Unit name/state, MainPID, cgroup, unit/drop-in file digests, start stability, next-start authority (unknown if unattested) |
| `units[].processes[]` | Actual PID, parent, UID/GID, boot/start ticks, executable/cwd/entry; separately named **installedEntry** digest; actual Node version/ABI when readable; safe path selectors, HOME/socket/vendor paths, environment key names and managed-path digest; current public Web self-report |
| `processes[].configs[]` | Selected config path/key names, allowlisted tool/data paths; descriptor schema/PID/machine identity only; ACP current/retained generation IDs/states, with occupancy still unknown |
| `deployments[]` | Installed current/previous pointers and exact replay state, distinct from running workers; pointer digest. A pointer is not content or ready proof |
| `stores[]` | Read-only physical schema hash, user/schema version, schema_migrations checksum ledger when present; Codex admission epoch/generation/incarnation/durable binding and claim counts when that exact schema exists; owner, compatibility, backup and complete occupancy remain unknown without owner proof |
| `storeDiscovery` | Actual data roots from processes/config, bounded depth 5 / 256 discovered paths; incomplete coverage explicitly unknown |
| `unmanagedUnits/unsupportedComponents` | Discovered services/timers outside the product owner map, explicitly unsupported with unknown impact |

Statuses distinguish `observed`, `inactive`, `not-installed`, `external`,
`unsupported` and `unknown`. `not-installed` only means the explicit standalone
unit is absent; it never asserts an engine is absent inside a combined process.
Enabled engine/auth policy is not inferred from unit presence. CLI, Pi and ACP
payloads can be installed while disabled. Installed bytes are not the bytes
attested by a long-lived process; `runningSource` remains unknown without a live
owner source contract. Paths containing a SHA are only `path-only` evidence.

`resources` reports filesystem available bytes, free/total RAM and probe Node;
ports, process headroom, update authority and dependency reachability are unknown
without owner evidence. Volatile budgets and sampling clocks are outside the
inventory fingerprint. They are in the plan digest and must be rechecked by P2b.
Raw argv, environment/config values, descriptor URLs/tokens and user rows are
never returned. Store inspection uses readOnly SQLite transactions, never the
managed database opener (which can migrate), DDL, recovery or backups. SQLite read
locks and system/kernel reads are ordinary observation, not an admission fence.
Missing/unreadable/busy stores stay unknown and are never created.

Plan has `schemaVersion:1`, `kind:"opencraft.upgrade-plan"`, `mode:"read-only"`,
`target` with signed identity and exact manifestSha256, `checks[]`, `components[]`,
`owners[]`, `compatibilityMatrix[]`, `expected`, `planDigest`, `planId`,
`generatedAt`, `blockedReasons`, `executionOrder:[]`, `replanOnDrift:true`, and
`automaticSnapshotRestore:false`. Each target component carries exact content
root/file-list digest, associated current process observations, `proposedAction`, `comparison` (package-pointer versus running/content evidence), `proposedSteps`,
`enabledPolicy`, `interruption`, `recovery`, `status` and `blockedReasons`.
Distribution roots such as LICENSE/package metadata are not invented runtime
owners; they explicitly report missing independent owner mapping.

Checks cover design §3.2: authenticated target; actual profile/platform; stable
incarnations; new/new declared dependencies plus old/new, new/old, rollback and
retained CLI/Host/browser combinations; storage/backup/rollback; full disk peak,
RAM, ports/processes, UID/permissions, dependency reachability and agent/helper.
An exact provides/requires match can verify a final declared pair; absence of
protocol declarations is **unknown**, not proof of coexistence. Signed budget
ceilings are not measured resource demand. The plan reports exact target payload
bytes, the signed ceilings and available capacity separately; additional disk/RAM
peaks remain unknown until reuse, retained generations, temporary unpacking,
owner working sets and all backups are established. Capacity below a budget ceiling
alone does not prove insufficiency. Read access does not prove installation privileges.

P1 complete manifests currently mark independent activation unsupported and do
not attest all mixed-runtime/storage combinations. Therefore P2a plans are
`status:"blocked"`, `executable:false`; each component states what a later agent
would need to do and why it cannot currently authorize it. This is the correct
result even when the Web pointer already names the target release. No synthetic
execution order or claim of “all components already latest” is emitted.

## Handoff to agent and page

`planDigest` is SHA256 of recursively sorted JSON of the complete plan body,
excluding planId/digest/generatedAt; `planId` is `plan-` plus that digest.
`expected` fixes inventory fingerprint, boot, adapter profile, signed target
manifest digest/sequence, replay digest, deployment pointer digests, process
PID/start/boot/environment path digests and policy/trust digest. The basic
`checkPlanExpectations` helper only compares fingerprint/boot/manifest and never
authorizes execution. P2b must re-verify signature/revocations, repeat owner CAS
and volatile resource checks at the correct fence, and replan on drift. A page
must not submit paths/commands/trust keys from this diagnostic object as authority.
P2b needs its own typed persisted plan/lease acceptance boundary and storage owner
proofs; P2a neither creates a journal nor claims a future transaction is safe.
