# Generation upgrade transactions

The persistent upgrade agent supports an explicitly provisioned generation-only
recipe through private `generation-inspect` and `generation-apply` operations.
No Web UI or full-stack completion is implied. Other owner adapters remain
unavailable, so a full-stack plan remains blocked.

A recipe is a root-owned local JSON file selected by `generationRecipePath` in
the fixed agent configuration. It declares `schemaVersion: 1`, `kind: acp`,
`targetId`, `definition`, `matrixPath` and `signaturePath`, and uses the ACP
Host's private `descriptorPath` and `definition.configPath`. These paths, commands and
credentials cannot be supplied through IPC. Official upgrades preserve this
local recipe reference. `releaseRoot` may fix a signed retained package; otherwise
the current official package supplies the verified closure. The agent metadata
artifact alone does not contain executable payload. Credentials never enter the journal.
ACP configuration bytes and actual command/script content are additionally
pinned in the signed combination and policy digest. Initial ACP support requires
an absolute command and absolute script arguments within the signed closure;
only the tested `--expose-internals` flag is accepted. External executables,
relative script arguments, standard loader-injection environment keys and
product launch rewrites are blocked.

The compatibility matrix has `schemaVersion: 1`,
`kind: opencraft.generation-compatibility`, exact `manifestSha256`, integer
`expiresAt` (Unix milliseconds), and `combinations`. Each allowlisted row has
`status: verified`, `forward: true`, `rollback: true`, `retainBindings: true` and
an exact `combination`: `ownerId`, `targetId`, `from` (live owner snapshot hash),
`to` (definition and private configuration hash), `profile`, `platform`, `arch`. It uses the existing
Ed25519 detached envelope and the deployment trust root. No SemVer range,
untested origin, unsigned matrix or inferred rollback is accepted. A fresh
owner incarnation needs a new attestation; packages cannot supply trusted keys.

The accepted plan binds the signed manifest, inventory fingerprint, fixed local
policy/configuration and matrix digests. Under the host deployment lock the
agent re-verifies live release/revocation policy and inventory before preparing
and before activation. The second comparison permits only this operation's new
candidate generation entry; existing owner identities,
defaults, bindings, schemas and deployment pointers remain in the comparison.
Any other drift requires replanning. The original owner snapshot is checked
again after preparation; native preparation receipts enforce the final owner CAS. Preparation and activation
carry the plan expected owner/Host identity, so a replacement owner cannot mint
a new receipt on behalf of the old plan.

Every mutation has a durable intent followed by a bounded receipt. Journal
persistence failure stops mutation and compensation. After restart an uncertain
intent requires reconciliation and is never replayed. Normal activation ends in
`active-draining`: old work and history stay with their existing owner. It does
not automatically cancel tasks, migrate HOME, reclaim artifacts or declare
full-stack success.

Owner activation persists the operation key, generation, owner and admission
epoch with the default update. A failed activation can retract only this operation's exact new default and
admission epoch under the same owner/Host incarnation and with this exact native operation
receipt. An intent alone does not prove who performed the CAS. A prepare/add
without a confirmed completion stays `recovery-required`; temporary absence
cannot rule out a still-running request. Compensation uses another
fresh preparation receipt and owner CAS. Later writers or restarted owners
produce `recovery-required`. A successful compensation ends in `rolled-back`,
retains any newly admitted history and records cleanup as `discarded`, `retired`,
`dormant` or `retained`. Native occupancy remains authoritative; unknown/busy
cleanup does not imply an empty generation. Repeated operation IDs return the
existing job and cannot retarget it.

Focused tests: `node --test tests/server/web-deployment-generation-upgrade.test.mjs`
and `node --import tsx --test tests/execution/full-upgrade-generation.test.ts`.

## Codex Generation Router（已删除）

The Codex `kind: codex` recipe, the standalone Generation Router
(`generations.cjs`, `codex-generations.sqlite`, its `/owner-handoff`,
retention, cold-validation and responsibility-evidence protocols) and its
systemd unit were removed on 2026-11-22: no deployment used the systemd full
release that ran it. A recipe with `kind: codex` is now rejected as
`invalid-generation-recipe`. Read-only inventory still reports a leftover
`codex-generations.sqlite` if one exists on an old host; nothing opens it for
writing. The planned successor for uninterrupted Codex upgrades is
per-workspace container image pinning in
[WorkspaceHost](../architecture/platform/workspace-host-split.md#35-generation-router已删除).
