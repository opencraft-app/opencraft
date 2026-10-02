# Clean-room fleet rebuild audit

Audit date: 2026-09-09

> Current decision: see `scalable-operable-qualification.md`. The body below is
> retained as the historical gap analysis and evidence trail; its original
> NO-GO verdict is not the current fleet qualification.

> Status update, 2026-09-13: the convergence failures exposed during the
> clean-room cloud replay are classified and resolved in
> `convergence-postmortem-20260913.md`. In particular, Runtime static ownership,
> request-scoped Hub readiness, later Argo release authorization, finite-node
> rolling topology, stable public capacity errors, and management toolchain
> pinning now have executable gates. This does not reopen A/B admission:
> release-bound Bottomless/DR/HA/autoscaling receipts must still be regenerated
> for the current Runtime releases.

> Status update, 2026-09-12: the original gap analysis below is retained as
> historical evidence. A clean-room Beijing C/A/B fleet has since been built,
> both Cells admitted, and public `/v1` placement plus API Pod replacement
> qualified. The regional Code Plane now also has a formal resumable
> Terraform-to-Argo state transition and immutable chain receipt under
> `terraform/create-first/rebuild/`. The original NO-GO therefore no longer
> describes deterministic empty-fleet reconstruction; long-duration soak and
> unbounded-scale claims remain deliberately outside that qualification.

The 2026-09-12 replay used reviewed source commit `c14d3da00` and exercised
the new state machine against the live rebuilt C plane. Its first two attempts
failed closed on a stale management image-generation lineage. The supported
pull/platform/Git promotion path then preserved every management resource UID
while rebinding the unchanged component image digests to the current complete
inventory. The resumed Code Plane phase passed with receipt SHA-256
`aa0f2ceed03cd71c2c60b7c5400eceed010a8ecd73714e4d71e39a96b0f4e390`.
The final public admission receipt SHA-256 is
`276d483a99867efe8b550a95d41c738a50b6393d65f3e5655e829be64147d300`;
it binds both Cell routes, Code Plane identity, physically restorable backup,
1,049 successful HA requests (1,018 during API Pod replacement, zero
failures), and a fresh successful request to the placed Worker object. Both
receipts were read back from content-addressed Beijing COS recovery keys.

Decision: **NO-GO for deleting every cloud resource and immediately serving
production traffic from a zero-history rebuild.** Source recovery, regional
image supply, and the prior central Argo management installation have real
Beijing-cloud evidence. The create-first source path now covers management and
Cell platform bootstrap plus the joined first-placement receipt; its remaining
blocker is executing that exact path on a new Beijing fleet and retaining the
resulting evidence.

This audit treats any remembered cloud ID, manual patch, file copied from an
old node, unpinned deployment input, or artifact available only in a build
cache as a rebuild defect. Retaining application data is outside this audit;
the requested exercise starts empty.

## Proven rebuildable now

| Surface | Evidence | Result |
|---|---|---|
| Terraform state bootstrap | `terraform/create-first/bootstrap-state` creates one encrypted, versioned, protected COS backend bucket | pass |
| Regional foundation | `terraform/create-first/foundation` creates TCR, namespace, complete private repository inventory, and regional CCN | static pass; cloud apply pending |
| Management cluster C substrate | `terraform/create-first/management` creates the management VPC/TKE and three zonal workers (one is the bootstrap host), then binds it to TCR/CCN without q01 identities | static pass; cloud apply pending |
| Management Argo platform | hash-locked complete Argo HA install includes CRDs/cluster RBAC, resolves all images from the 28-image lock, requires three ready zonal workers, and emits exact workload/CRD UID evidence | static pass with real 70-resource upstream rendering; cloud execution pending |
| Management desired-state Git | complete image-lock rendering, retained PVC, cluster-owned immutable publisher/reader credentials, effective read-only Argo access, generic Cell publication and ApplicationSet receipt binding | static pass; create-first cloud execution pending |
| Management Workers API desired state | final public admission receipt renders an exact credential-free tree; CAS publication and a commit-pinned least-privilege Argo Application adopt the existing Deployment/private CLB Service while preserving Secret and VIP ownership | pass: C revision `db4f68c6181ed132c96b3ff3f07f741c0fc757ac`, 11/11 resources, A/B source preservation and self-heal; archived receipt SHA-256 `d754e270596f876a0ce7136ff4e1d558410664284f06cc974de4f7f125ec58da` |
| Hub-to-Cell network | Terraform attaches C and every Cell VPC to the same regional CCN; Cell API ingress derives C's VPC CIDR from management state | static pass; exact private route/SG/mTLS cloud proof pending |
| One new Cell | `terraform/create-first/cell` creates VPC, three subnets, SGs, TKE, bootstrap worker, private endpoint, TCR/CCN attachments, COS buckets, and scoped CAM roles | static pass; cloud apply not yet exercised |
| New Cell platform bootstrap | a reviewed operation installs CRDs, private FDB Operator, exact Profile/Class and private Fleet controller before production Argo registration | static pass with receipt join; cloud execution pending. Engine/Host intentionally follow Argo MachineSet/Cell convergence |
| Independent Cell state | backend prefix is `actor-fleet/cells/<cell-id>` and `init-backend.sh` isolates `TF_DATA_DIR` per Cell | pass |
| No remembered cloud IDs | `create-first/verify.sh` rejects Tencent resource-ID literals in template inputs | pass |
| Terraform-to-Git handoff | renderer binds Pool UID, Claim UID, scale-out epoch, class/profile digest, cloud inventory, and capacity policy into a hash receipt | pass |
| Machine capacity manifests | renderer emits three self-contained Kustomizations; all render in a clean temporary directory | pass |
| workerd fork source | the tracked 41 MiB bundle records complete history and restores locked commit/tree/tag without GitHub or `/data/build-cache` | pass |
| Reviewed release source bundle | full Git tree is packaged reproducibly, published without replacement, and bound to a strict immutable receipt; interrupted bundle/receipt publication is restart-safe | pass: release `b337957b6c12844f0d7e2066759de6913c469e55` was published through the content-addressed Beijing COS relay, restored on q01, and passed the full manifest/static gate |
| FDB Operator CRDs | all three CRDs are vendored with upstream commit and SHA-256 lock; deployment installer performs no download | pass |
| Central Argo registration | C permanently installs the generic `actor-cells` ApplicationSet beside the static A/B fixture; bounded publication, production-scoped least-privilege registration, exact ApplicationSet UID/ownerReference, repository/revision/path binding, drift repair and controller-restart recovery are proven locally | pass: three-k3s receipts `local-appset-registration-20260909T094051Z.json` and `local-appset-convergence-20260909T094051Z.json`; q01/C install invocation `inv-a8f9bbgvmk`, ApplicationSet UID `c2e5ae73-6cfb-4e87-9739-418e4db23f23`; both pre-existing Applications remained byte-identical in identity/source binding |
| Regional image inventory | 17 upstream images and five product-foundation sources are digest locked; all 11 product builders cold-pull and attest OCI source identity; their receipts assemble into the exact 28-repository Terraform inventory | pass: upstream seed `image-seed-20260909T072009Z.json`; 11/11 build receipts under `product-build-754a6d37f0b5cf2f396d4ddfab630dd3`; inventory digest `sha256:b82a365f65f84ffa910bd201dadc902e927719380d78bfc3a4d5db58e1bfbc96` |
| Blank-cluster private image pull | inventory-driven bootstrap joins Terraform TKE/VPC/TCR identity to the complete image lock, verifies the private endpoint, installs role-scoped Secrets, and emits a token-free immutable receipt | static pass; cloud execution on create-first C/Cell pending |
| Cell-scoped COS identity | Terraform creates independent API-only cold/backup users limited to one exact bucket; bootstrap joins their protected keys to TKE/pull/inventory identity and installs immutable Secrets | static pass; cloud permission probe pending |
| FDB private image rendering | production Operator install and regional FDB profile resolve operator/monitor refs from the same complete image lock; profile/Class digest is recomputed and receipt-bound | static pass; cloud cold-pull pending |
| Runtime stage from source | checksum-locked Zig/Bazel, complete bundled workerd history and FDB 7.3.79 client produced a verified static-PIE workerd stage without reading a prior runtime image; the independently versioned workerd cache now survives infra-only revisions | pass at source `0f02197cbbf4825389bce350619dd925bbc31ed2`; stage receipt `runtime-stage-754a6d37f0b5cf2f396d4ddfab630dd3-0f02197c.json`; final cold-pulled runtime digest `sha256:1e391f738c5e05507ff0d6a2e2e4121d495fee751a181609e7101ba13c8290e5` |
| Existing fleet manifests | `verify-manifests.sh` runs without a Kubernetes context and passes all static invariants | pass |

The repeatable local gates are:

```bash
./infra/cells/deploy/tencent/fleet/terraform/create-first/verify.sh
./runtimes/workerd/verify-source-bundle.sh
./infra/cells/deploy/tencent/fleet/verify-manifests.sh
```

## Remaining blockers

### P0 — apply and qualify the create-first management/network substrate

The `foundation`, `management`, and `cell` roots now declare the regional CCN,
C VPC/TKE and both CCN attachments. A Cell derives C's VPC CIDR and cluster
identity from management state, so a remembered q01 ID is not an input.

The remaining gate is a real cloud apply plus active probes for C Argo to Cell
Kubernetes API, C Workers API/ingress to private gateway, and Guard-to-peer
gateway. CCN establishes reachability, not authorization: endpoint/CLB
security groups and gateway mTLS must reject every other path in
`network/ccn-plan.yaml`. Pod and Service CIDRs remain outside CCN.

### P0 — generic Cell platform bootstrap

The production `actor-cells` ApplicationSet intentionally has narrow write
authority and renders only `MachineSet` plus `RivetCell`. A fresh TKE target
does not yet contain the RivetCell CRD, FDB Operator, Fleet controller,
FoundationDB cluster, Engine or runtime Hosts. The existing working installers
are partly generic, but q01 registry, credentials, code-plane, observability
and autoscaling entry points still contain explicit q01 cluster/resource
identities. They are qualification recovery tools, not a clean-room bootstrap.

The common private-image dependency is no longer q01-bound:
`terraform/create-first/bootstrap/install-pull-credential.sh` validates the
exact Terraform cluster/VPC/TCR and 28-image inventory, installs only the
management- or Cell-specific namespace Secrets, and emits an immutable
token-free receipt. The storage/TLS and platform-floor phases now require that
receipt; they may not mint another pull credential or fall back to a public
registry.

The generic platform-floor bootstrap now emits a receipt joining pull,
bucket-scoped storage, FDB TLS, regional Profile/Class, FDB Operator and Fleet
controller identities. Remaining work is cloud execution followed by
MachineSet/RivetCell convergence, runtime release, and final
destruction of the one-time administrator kubeconfig after those receipts are
retained.

### P0 — execute the create-first management platform

The prior q01 renderer consumed Argo's namespace-only HA manifest and relied on
pre-existing CRDs/ClusterRoles; it also embedded q01's TCR. That path could not
bootstrap an empty C cluster. The create-first operation now verifies the full
70-resource Argo HA install hash, includes all three CRDs and cluster RBAC,
resolves the four Argo images from the exact regional image inventory, and
records all eight workload plus CRD UIDs. Management Terraform now starts one
schedulable worker in each of three zones because the upstream HA manifest has
hard hostname anti-affinity. The generic desired-state Git/repository bootstrap
now consumes the same inventory and gates ApplicationSet installation on live
receipt verification. Remaining work is real Beijing execution and installation
of the management product controllers/APIs from their private digests.

### P0 — source and image supply replay on the create-first Cell

The local repository currently has no configured Git remote. The deterministic
full reviewed-source bundle and strict immutable receipt therefore remain the
recovery mechanism. Release `b337957b6c12844f0d7e2066759de6913c469e55`
was uploaded under its content hash, restored on the q01 builder without an old
working tree, and verified file-by-file before its static gate ran. The
create-first workflow must repeat that exact operation against its newly
created foundation before old cloud resources are deleted.

`gitops/image-seed` pins all
17 third-party inputs by source digest, mirrors through isolated Buildah state,
records exact TCR destination digests, and joins them with provenance for all
11 product builds. A product receipt can no longer be minted from a typed
digest alone: its supported recorder cold-pulls that exact digest and checks
the source revision and source-manifest OCI labels. Six application builders
invoke it directly; one reviewed, restart-safe foundation operation builds the
other five from their locked upstream digests. One unified `base-golang`
replaces the historical tag-dependent variants, and one `cc-debian12`
`base-distroless` supports both static and FDB-linked binaries. The Terraform
repository inventory is mechanically required to equal the final 28-image
contract. The q01 qualification TCR has now completed the actual 17-image seed,
all 11 product builds and isolated cold pulls, and the final 28-image inventory
lock. The runtime build also caught and corrected an inherited base-image
`org.opencontainers.image.revision` label before it could mint a receipt. A new
Cell must still remain closed until it cold-pulls the inventory's exact digests;
the remaining P0 is replaying this completed supply operation from the future
create-first foundation rather than producing the artifacts themselves.

### P0 — first create-first Cell registration through central Argo

The generic operation now publishes the exact rendered handoff with a normal
fast-forward Git update, consumes the sensitive Terraform kubeconfig, installs
scoped bootstrap RBAC, creates a least-privilege Argo cluster Secret in C,
selects it through an ApplicationSet, and emits publication/registration/
convergence receipts. The management installer merges Argo's global inventory
policy rather than overwriting existing inclusions; all existing target
identities retain read-only discovery for globally included kinds. A dedicated
`registration-scope=production` selector prevents local/E2E Secrets from being
adopted by the production controller. The verifier binds the live Application
to the exact repository, path, revision and `actor-cells` UID through its
ownerReference. Local C/A k3s E2E proves drift repair, replica-field ownership,
controller replacement and coexistence with the permanent management objects.
Registration now has a hard platform-floor prerequisite: before its first
write it joins the immutable platform receipt to Terraform/publication identity
and rechecks the live cluster UID, FDB/Fleet controller UIDs, digest-pinned
images/readiness, and Profile/Class UID/spec. The platform receipt and cluster
UID propagate through the Argo Secret, Application and convergence receipt.
The generic project and ApplicationSet are now installed in q01/C from the
restored reviewed source. Its production selector intentionally matches zero
cluster Secrets today, and installation proved that the two legacy static
Applications were unchanged. The remaining gate is registering a newly created
Beijing private TKE endpoint and securely destroying its one-time kubeconfig
after the per-Cell registration and convergence receipts are retained. No
kubeconfig or token may enter Git or a non-secret receipt.

### P0 — joined admission execution

The source workflow now reconstructs the complete image inventory from the
upstream lock, actual TCR seed, product lock, and all 11 exact build receipts,
then validates the exact Terraform inventory, management Argo/Git/desired-state
receipts, handoff, Git publication, Cell platform, registration and convergence
receipts before assembling one receipt across
that evidence, FDB TLS bootstrap, route publication,
the exact autonomy audit and allow-control bytes, human activation CAS, public
DO creation, Registry FDB placement and the exact live Actor. Its
restart-safe completion step deterministically reuses the same first Object.
The remaining blocker is executing that workflow against a clean Beijing Cell
and retaining its real receipts together with the cold tier, backup/restore and
node-replacement qualification evidence. The intended first-production policy
keeps a human, receipt-bound admission CAS after qualification; it does not use
an independent mutable `accepting` boolean.

### P0 — production execution of admission-aware Agent placement

The serving adapter now consumes only a current-generation, open ShardPool
snapshot, independently rechecks Cell report expiry and logical/spoke UID, and
requires an immutable route bound to Terraform/Argo convergence. The Worker
Registry requires and atomically persists the winning placement before Actor
creation, so three API replicas cannot assign one object twice. A local
three-cluster gate has read that exact winner back from Registry FDB while
proving API replacement and terminal delete behavior. Remaining work is to run
the same public API/FDB evidence path on the new Beijing Cell and join its
receipt to the production Terraform, Argo, image and qualification receipts.

### P1 — TLS and protected bootstrap

`generate-self-signed-tls.sh` enforces a roughly 100-year leaf lifetime and
refuses to overwrite an output directory. The generic
`bootstrap-cell-tls.sh` operation now runs it for any new Cell, validates file
permissions, certificate/key/SAN identity and lifetime, creates only the three
exact immutable Kubernetes Secrets, rejects divergent existing Secrets, and
publishes a restart-safe receipt containing UIDs and public material hashes but
no key bytes. Its fake-Kubernetes lifecycle gate passes locally. The remaining
evidence is execution against a newly created Beijing Cell and retention of
the private directory in protected storage; q01-local paths are no longer part
of the operation contract.

### P1 — builder/toolchain recovery

Terraform provider locks and source checksums exist, but the full Go,
Helm, Terraform, Tencent CLI, and remaining base-image acquisition graph has
not been restored on a blank node from a single reviewed lock. Zig 0.14.1 and
Bazel 9.2.0 now have official URL/checksum locks, a cache-independent installer
and an immutable receipt; the installer has been exercised from cold downloads.
The q01 TencentOS 3.1 builder now pins Rust 1.96.0, uses Python 3.11 plus the
distribution PyYAML package for source verification, and fails before Cargo if
its glibc ABI differs from the digest-pinned Rocky 8 runtime base. Its final
Engine/Host build stayed inside a 6 GiB/2 CPU scope and produced the cold-pulled
runtime receipt above.
Runtime staging no longer extracts `workerd`, `init-workerd-pool`, or
`libfdb_c.so` from a prior runtime image: a real clean-source run built the
bundled workerd fork and verified the locked FDB client package into
`/data/actor-qualification/receipts/clean-room-runtime-stage-146a8f564470a5d3b7ef214c702219ce73a4193d.json`.
The build exposed unsafe implicit 64-way V8 compilation; the source-controlled
entry now defaults to 16 jobs, validates an explicit override, and records the
selected parallelism in new stage receipts. Static workerd uses a serialized
cache keyed by its own commit and tree, while Rust artifacts use a stable Cargo
target outside the immutable release source; neither cache is treated as
evidence. The remaining gap is acquiring the other exact builder executables
above on a blank node.
`/data/build-cache` is allowed as disposable acceleration only after that test;
it cannot be the sole copy or source of identity for any artifact.

## Manual Cell expansion contract

Cell expansion is intentionally not an unreviewed controller action:

1. Fleet creates one immutable `RivetCellClaim`.
2. An operator copies its Pool/Claim UID, epoch, class/profile binding into a
   new tfvars file and reviews one independent Cell plan.
3. Terraform apply creates only that Cell and emits credential-free inventory.
4. The renderer produces immutable Git desired state and a handoff receipt.
5. Central Argo installs it; qualification runs while placement remains closed.
6. The operator reviews the joined receipt and invokes the guarded admission
   CAS. The Fleet controller then derives `readyForPlacement=true`.
7. The resolver may allocate only new Agents to the Cell. Cell deletion stays
   manual and is not part of autoscaling.

This is compatible with adding Cells through a small Terraform SOP while Host
and Pod capacity continue to scale automatically inside each Cell.
