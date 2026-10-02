# Pre-destroy rebuild gate

This gate proves that the currently managed C/A/B fleet can be reconstructed
without a remembered cloud ID, an old node filesystem, or `/data/build-cache`.
It does not destroy resources.

The Terraform state bucket is the one deliberate bootstrap seed. It is
versioned, encrypted, private, and protected by Terraform `prevent_destroy`.
It must be excluded from every fleet destroy. The gate publishes only
content-addressed copies of the exact Git source bundle, complete digest-pinned
image inventory, and locked Terraform archive into `recovery/v1/`, reads back every byte, downloads all four remote
Terraform states, including the operations-network route-policy state, runs the static create-first gate, and emits a machine-readable
receipt.

Run from any checkout of the intended release:

```bash
export COS_SECRET_ID=...       # operator bootstrap credential; never persisted
export COS_SECRET_KEY=...
./run.sh \
  actor-terraform-state-beijing-1388575217 \
  /data/actor-release/all-images.lock.json \
  /data/actor-rebuild/pre-destroy-audit.json
```

`verdict=passed` requires:

- a completely clean Git worktree;
- a deterministic source bundle for exactly the mono2 `HEAD`, repository tree,
  `minisandbox` project path, and project tree;
- verified COS readback of that bundle and its receipt;
- a complete 28-image inventory for the exact foundation TCR, with verified
  COS readback under a content-addressed recovery key;
- a source-locked Terraform archive with verified COS readback;
- an enabled-versioning recovery/state bucket;
- live, nonempty and structurally complete foundation, management,
  operations-network, A and B
  Terraform states;
- distinct management/A/B TKE and VPC identities; and
- the complete create-first static/validator suite.

A blocked receipt is intentionally left only at the requested local path. A
passing receipt is additionally published by its SHA-256 under
`recovery/v1/audits/`. The follow-on destroy planner must accept only that
passing receipt and must explicitly exclude the state/recovery bucket.

The reviewed planner destroys only management C or one declared Cell. It never
accepts `foundation`: the regional TCR and CCN are the retained bootstrap plane
for a C/A/B clean-room rebuild. Run it only after placement is closed,
Kubernetes-owned Machines are retired, the exact scope-owned data buckets are
empty, and a separately reviewed plan has disabled TKE/CVM deletion
protection:

```bash
install -d -m 0700 /data/actor-rebuild/plans/actor-bj-a01
./plan-destroy.sh \
  /data/actor-rebuild/pre-destroy-audit.json \
  /data/actor-rebuild/all-images.lock.json \
  actor-bj-a01 \
  /data/actor-rebuild/actor-bj-a01.tfvars.json \
  /data/actor-rebuild/plans/actor-bj-a01
```

`destroy.tfplan` and its JSON form contain sensitive Terraform state and remain
mode `0600` under a mode `0700` directory. The ordinary
`destroy-plan.receipt.json` binds the plan bytes to the audit, current state
lineage/serial, exact TKE/VPC IDs and deletion inventory without copying any
secret values. Validation rejects creation/update/replacement actions,
foundation TCR/CCN resources, the shared TKE OIDC attachment, a state bucket
delete, stale audit source, different image bytes, or different live TKE/VPC
identities. Applying a plan remains a separate explicit operation.
