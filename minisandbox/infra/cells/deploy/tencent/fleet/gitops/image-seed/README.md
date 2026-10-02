# Cold TCR image seed and complete image lock

This directory separates two proofs that must not be conflated:

- `upstream-images.lock.json` pins every third-party runtime, FDB, Argo and
  observability source by its registry digest. `seed-tcr.sh` mirrors these
  sources through a fresh Buildah storage root, records the destination
  registry digests returned by TCR, then pulls every digest through its own
  second empty VFS storage graph. A pull from the push/source graph is not
  accepted as cold-start evidence, nor may one verification image warm another.
- internally built images are supplied as a product lock, each bound to its
  source revision, complete source-manifest digest and build-receipt digest.
  `image-lock.py assemble` joins both sets and refuses output unless all 28
  Terraform-declared repositories are present.

The deterministic transport tag is not deployment identity. Rendered
workloads must consume only the final `registry/repository@sha256:...`
reference; wiring every installer to the final inventory is a separate
qualification gate and is not proven by a seed receipt.
No registry credential, token, image pull Secret, Terraform state, or plan is
written to either receipt.

Build the five dependency/root images from their reviewed upstream digests in
`foundation-images.lock.json`. This produces the first five normalized product
receipts and is restartable only with the same source identity and run ID:

```bash
ACTOR_SOURCE_DIR=/path/to/reviewed-source \
ACTOR_PRODUCT_REGISTRY=<regional-tcr>.tencentcloudcr.com \
ACTOR_PRODUCT_BUILD_RUN_ID=<32-lowercase-hex> \
ACTOR_PRODUCT_RECEIPT_DIR=/data/actor-qualification/receipts/<run> \
REGISTRY_AUTH_FILE=/protected/tcr-auth.json \
  ./build-foundations.sh
```

One `base-golang` image intentionally serves all Go product builders and the
Python load generator. It contains the exact Go toolchain, the verified module
cache and Python 3. `base-distroless` uses the `cc-debian12` variant so the same
identity supports both static binaries and Worker Registry's FDB-linked CGO
binary. Creating variant images under either repository is forbidden because
it would make dependency closure depend on a remembered tag.

Seed an empty Beijing TCR foundation from a protected builder:

```bash
IMAGE_SEED_REGISTRY=<regional-tcr>.tencentcloudcr.com \
REGISTRY_AUTH_FILE=/protected/tcr-auth.json \
IMAGE_SEED_RECEIPT=/data/actor-qualification/receipts/image-seed-<run>.json \
IMAGE_SEED_REGISTRIES_CONF="$PWD/tencent-dockerhub-mirror.registries.conf" \
  ./seed-tcr.sh
```

The generic entry point requires Python 3.7 or newer and accepts an exact
interpreter through `PYTHON`.  TencentOS builders whose system `python3` is
3.6 use the preinstalled `/usr/local/qcloud/python/bin/python3.7`; this choice
must be explicit in the unattended builder command and is checked before any
registry mutation.

The checked-in registries configuration sends only `docker.io` reads through
Tencent's pull-through mirror. Quay, GHCR and ECR retain their reviewed source
origins, and every source is still selected by the lock's exact digest. Pass
that file explicitly with `IMAGE_SEED_REGISTRIES_CONF`; no workstation-global
container configuration is part of the rebuild contract.

Every successful product build must emit one immutable normalized receipt.
The only supported recording entry point cold-pulls the exact TCR digest,
reads its OCI labels back, compares them with the reviewed source identity,
and only then publishes the receipt. Supplying a digest to the receipt
assembler is not pull proof:

```bash
python3 record-product-image.py \
  --repository workers-api \
  --ref <regional-tcr>/actor-fleet/workers-api@sha256:<digest> \
  --source-revision <40-hex> \
  --source-manifest-digest sha256:<64-hex> \
  --dependency base-golang=<regional-tcr>/actor-fleet/base-golang@sha256:<digest> \
  --dependency base-distroless=<regional-tcr>/actor-fleet/base-distroless@sha256:<digest> \
  --registry-auth-file /protected/tcr-auth.json \
  --output /data/actor-qualification/receipts/product-workers-api-<run>.json
```

The dependency set is fixed per product. For example, `rivet-runtime` must
bind `runtime-base`, `release-hook` must bind `base-tencentcloud-cli`, and all
Go services must bind the same assembled base refs they actually consumed.
An old base digest cannot be hidden behind the same repository name.

Leaf products can be promoted into an already copied regional inventory
without rebuilding unrelated products or replaying the original cross-registry
copy. The promotion verifies each cold-pull receipt, requires the same registry
and namespace, checks its exact base dependencies against the current
inventory, replaces only the named leaf entries, and publishes a new
self-authenticating inventory. Foundation products are deliberately rejected;
changing one requires a complete generation rebuild so every reverse
dependency is rebuilt against the new base.

```bash
python3 product-lock.py promote \
  --inventory /data/actor-create-first/image-generation/all-images.lock.json \
  --receipt /data/actor-build/releases/<revision>/product-workers-api.json \
  --receipt /data/actor-build/releases/<revision>/product-actor-fleet-controller.json \
  --output /data/actor-build/releases/<revision>/all-images.lock.json
```
The recorder always pulls through a disposable, empty Buildah VFS graph and
inspects the returned local image identity there. A product builder's default
Buildah/Docker cache is never accepted as `registryPullVerified` evidence.

Assemble the 11 normalized receipts rather than hand-writing a product lock:

```bash
python3 product-lock.py assemble \
  --receipt /data/actor-qualification/receipts/product-actor-fleet-controller-<run>.json \
  --receipt /data/actor-qualification/receipts/product-actor-loadgen-<run>.json \
  --receipt /data/actor-qualification/receipts/product-base-distroless-<run>.json \
  --receipt /data/actor-qualification/receipts/product-base-golang-<run>.json \
  --receipt /data/actor-qualification/receipts/product-base-tencentcloud-cli-<run>.json \
  --receipt /data/actor-qualification/receipts/product-git-service-<run>.json \
  --receipt /data/actor-qualification/receipts/product-release-hook-<run>.json \
  --receipt /data/actor-qualification/receipts/product-rivet-runtime-<run>.json \
  --receipt /data/actor-qualification/receipts/product-runtime-base-<run>.json \
  --receipt /data/actor-qualification/receipts/product-worker-registry-<run>.json \
  --receipt /data/actor-qualification/receipts/product-workers-api-<run>.json \
  --output /data/actor-qualification/receipts/product-images-<run>.json
```

The production entry point does not require operators to enumerate those
receipts. With all builders using the same run ID and receipt directory, it
derives the exact filenames, verifies all 11 dependency-closed receipts, joins
the 17-image seed, and atomically publishes both locks. Repeating the command
accepts byte-identical outputs and rejects any pre-existing file from another
generation:

```bash
ACTOR_PRODUCT_BUILD_RUN_ID=<32-lowercase-hex> \
ACTOR_PRODUCT_RECEIPT_DIR=/data/actor-qualification/receipts/<run> \
ACTOR_IMAGE_SEED_RECEIPT=/data/actor-qualification/receipts/image-seed-<run>.json \
ACTOR_PRODUCT_IMAGE_LOCK=/data/actor-qualification/receipts/product-images-<run>.json \
ACTOR_IMAGE_INVENTORY=/data/actor-qualification/receipts/all-images-<run>.lock.json \
  ./assemble-generation.sh
```

The output is the strict document consumed by `image-lock.py`:

```json
{
  "schemaVersion": 1,
  "registry": "example.tencentcloudcr.com",
  "namespace": "actor-fleet",
  "images": [
    {
      "repository": "rivet-runtime",
      "ref": "example.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:<64 hex>",
      "sourceRevision": "<40 hex Git commit>",
      "sourceManifestDigest": "sha256:<64 hex>",
      "buildReceiptDigest": "sha256:<64 hex>"
    }
  ]
}
```

The shown entry is illustrative. `product-lock.py` rejects duplicate/missing
receipts, mixed TCR registries, missing exact pull proof, unexpected base
dependencies and any dependency ref that differs from the assembled base
entry. Assemble the final 28-image inventory into a fresh path:

```bash
python3 image-lock.py assemble \
  --upstream-lock upstream-images.lock.json \
  --seed-receipt /data/actor-qualification/receipts/image-seed-<run>.json \
  --product-lock /data/actor-qualification/receipts/product-images-<run>.json \
  --output /data/actor-qualification/receipts/all-images-<run>.lock.json
```

An Argo install or Cell qualification may consume the final inventory only
after revalidating its `inventoryDigest`. A seed receipt alone is never enough
to open Cell placement.

```bash
python3 image-lock.py validate-inventory \
  --lock /data/actor-qualification/receipts/all-images-<run>.lock.json
```

`materialize-generation-evidence.py` is a forensic completeness check, not an
admission dependency. It can reproduce canonical seed, product-lock and build
receipt preimages only when the inventory contains enough exact information;
every reconstructed product byte stream must hash to the digest already bound
by the inventory. An older or manually assembled inventory that cannot satisfy
this test remains usable as a handoff-bound standalone inventory, but must not
be reported as having portable builder-preimage archives.

When a reviewed generation already exists in another private regional TCR,
`copy-inventory.sh` moves that exact generation without rebuilding product
images. It refuses any manifest digest rewrite, cold-pulls every destination
digest through a separate empty VFS graph, preserves the original provenance,
and emits a new self-authenticating inventory bound to the destination host.
The auth file must contain only the two exact registry hosts and is never
included in either output.

For isolated destination VPCs, first run `export-inventory-oci.sh` where the
source TCR is reachable, archive its shared OCI layout through the private
one-day COS relay, and set `SOURCE_OCI_LAYOUT` on `copy-inventory.sh`. Skopeo's
`--preserve-digests` gate applies on both sides; no registry is opened to the
public network and common layers occur only once in the relay layout.
The importer exposes each OCI entry through a temporary hard-linked `dir:`
view. This retains Docker-v2 manifest bytes on bootstrap hosts whose packaged
Skopeo cannot otherwise read that media type from an OCI layout.

The final inventory is the production installer authority, not only an audit
attachment. Resolve an exact reference or immutable build provenance with:

```bash
python3 image-lock.py resolve --lock /data/actor-qualification/receipts/all-images-<run>.lock.json \
  --repository rivet-runtime
python3 image-lock.py resolve --lock /data/actor-qualification/receipts/all-images-<run>.lock.json \
  --repository rivet-runtime --field source-revision
```

Production runtime and code-plane installers require the absolute
`ACTOR_IMAGE_INVENTORY` path. They derive all image references (and product
source identities) from it and reject even digest-pinned environment overrides
that differ. This prevents a valid 28-image receipt and a separately assembled
live workload from becoming two independent truths.
