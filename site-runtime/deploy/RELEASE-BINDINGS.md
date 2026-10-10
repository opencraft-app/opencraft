# Offline regional consumer bindings

This tool closes source-level release preparation; it never deploys, connects to Kubernetes,
reads Secret values, provisions a host or authorizes production. Use the frozen candidate's
script and source tree, not an unrelated checkout. Schema1 retains the stateless fetch-v1 input
contract; schema2 selects the regional driver and data gate. Schema3 removes the owner-list
field; enablement is regional and never an account entitlement.

## Regional inputs

Write a protected, references-only JSON file following this schema:

```json
{
  "schema_version": 3,
  "environment": "shprod",
  "source_tree_sha256": "REPLACE_WITH_FROZEN_SOURCE_TREE_SHA256",
  "runtime": {
    "environment": "shprod",
    "driver": "minisandbox",
    "base_url": "REPLACE_WITH_REGIONAL_PRIVATE_HTTPS_ORIGIN",
    "ca": {"name": "website-runtime-ca", "key": "ca-bundle.pem"},
    "deploy_token": {"name": "website-runtime-secrets", "key": "deploy"},
    "invoke_token": {"name": "website-runtime-secrets", "key": "invoke"}
  },
  "data_enabled": false
}
```

The placeholders are deliberately invalid, not a ready production configuration. For sgprod,
change **both** environment fields and use that region's own provisioned runtime output. The
HTTPS origin must use a private RFC1918 IPv4/ULA IPv6 address or a canonical Kubernetes
Service DNS name (`service.namespace.svc.cluster.local`), with matching certificate SAN.
Arbitrary public/private DNS names and short Service aliases are rejected; the example's placeholder URL remains invalid.
Do not promote testing IPs, test CA/token values or Beijing/Seoul machine image IDs into production.
Endpoint validation is syntax/provenance validation, **not** live TLS/CA/SAN or driver
verification. Schema2 requires a boolean `data_enabled` and a runtime `driver` of `runsc` or
`minisandbox`; persistent data is rejected for `runsc`. Schema1 has neither field and keeps
data/share gates closed. Declaring a driver is not runtime qualification evidence.
Secrets are provisioned through the authorized regional release process. Never put their values,
TLS private keys or decrypted SOPS contents in inputs, Git, arguments, stdout or the release pack.

## Render, default closed

Run from the extracted candidate source root with Python 3:

```sh
python3 .ci/runtime/commands/prepare_website_backend_release.py \
  --input /protected/release/shprod-runtime-references.json \
  --output /protected/release/shprod-prepared-bindings \
  --phase prepare
```

Output is references-only `manifest.json` and `overlay-patches.json` for ctl,
website-deployer and site-gateway. The manifest hashes every patch file. Existing output or
symlink destinations are refused. This command does not produce images or modify any source.
Prepare explicitly sets `WEBSITE_BACKEND_ENABLED=0` on CTL API/service even if an old
ConfigMap/envFrom enabled it. Prepare also explicitly sets CTL data to `0` and gateway
shared reads to `false`, overriding inherited gates. Do not roll a live Beta back to prepare
without owner review; closing share reads can affect existing shared links.

## Use normal source-facing release overlays

After release authorization, append each service's generated patch list to the **end** of the
existing `patches` list in the matching source-facing overlay, preserving all earlier patches:

| Generated patch set | Source-facing overlay in each region |
| --- | --- |
| ctl | `argocd/services/ctl/{shprod,sgprod}/kustomization.yaml` |
| website-deployer | `argocd/services/workers-website-deployer/{shprod,sgprod}/kustomization.yaml` |
| site-gateway | `argocd/services/site-gateway/{shprod,sgprod}/kustomization.yaml` |

Do **not** insert them as a Kustomize Component. The original CTL overlay has positional
JSON6902 removals; applying a Component before those removals can remove its rewrite-config
mount instead. The generated list contains inline strategic patches, so it can be appended
without copying an external directory or changing bundle publish_paths. A protected, offline
release staging checkout can be updated with the following explicit local-only step (PyYAML):

```python
import json
from pathlib import Path
import yaml

# Only in an authorized, isolated release staging checkout, not the active GitOps checkout.
region = "shprod"
bindings = Path("/protected/release/shprod-prepared-bindings")
folders = {"ctl": "ctl", "website-deployer": "workers-website-deployer", "site-gateway": "site-gateway"}
for service, folder in folders.items():
    patches = json.loads((bindings / service / "overlay-patches.json").read_text())
    path = Path(f"argocd/services/{folder}/{region}/kustomization.yaml")
    source = yaml.safe_load(path.read_text())
    source.setdefault("patches", []).extend(patches)
    path.write_text(yaml.safe_dump(source, sort_keys=False))
```

Do this once against the clean reviewed staging baseline; do not append repeatedly or combine
prepare+enable in one list. Review the resulting diff and render through the existing secure
KSOPS pipeline. Existing SOPS keys and auth/static/DSH/COS configuration stay intact. CTL and
worker receive only deploy references; gateway receives only invoke references. The opposite
role is explicitly empty (not deleted), so legacy envFrom cannot reintroduce it. This does not
change Kubernetes RBAC or stop a privileged process from reading an envFrom Secret; broader
Secret distribution must stay role-scoped. CA volume exposes only the selected public bundle,
read-only. No fixed image, authentication policy or old static-client route is changed.

The normal ctl/workers/site-gateway release bundles already publish these overlay paths.
Reconcile live schema and apply migration32 only if genuinely pending; qualify regional
runtime/storage first, then promote images and overlays using the existing
source-to-GitOps workflow, then manually sync the correct regional apps and verify revision,
image digest, Synced/Healthy and real business flows. A local render is not Argo proof.

## Explicit enable and new-machine adoption

Enable is a separate rendering phase with an approved nonempty owner allowlist:

```sh
python3 .ci/runtime/commands/prepare_website_backend_release.py \
  --input /protected/release/shprod-approved-canary-references.json \
  --output /protected/release/shprod-enabled-bindings \
  --phase enable
```

Prepare the enable diff against a clean baseline by replacing the previous generated patch
set, not layering duplicate entries. The explicit enable phase sets `WEBSITE_BACKEND_ENABLED=1` for authenticated users.
Legacy schema1/2 beta_users inputs are validated but ignored; schema3 omits them.
The frontend entry remains hidden until console `show()`; that is not API authorization. With schema2/3 `driver=minisandbox` and `data_enabled=true`, enable
renders CTL `WEBSITE_BACKEND_DATA_ENABLED=1` and gateway `SITE_GATEWAY_BACKEND_SHARED_READ=true`
together. Writes still require the owner; shared GET/HEAD still require valid generation-bound
share sessions. This hidden Beta is opt-in, not anonymous or public creation. Keep the data flag
false until that region's persistence, version replacement, rollback and isolation have passed.

New-machine build inputs remain `images/helpers/website_skill_bundle.py` and the same complete
Skill/scripts, verified in normal Beijing/Seoul provisioning. During authorized release, build
or copy that frozen image content into each production region, record the resulting regional
image IDs and set the normal-machine adoption mapping. Testing image IDs are regional and are
not production IDs. Check automatic per-instance credential delivery with a real new machine.
Post-launch stock Skill-only TAT rollout is performed by the user using the supplied versioned
install/rollback JSON and resume ledger; it must not rotate or backfill credentials.

## Offline acceptance gate

From the candidate source root, with PyYAML and kustomize installed:

```sh
python3 -m unittest discover -s .ci/runtime/tests/contract_tests \
  -p test_website_backend_release_bindings.py -v
```

The tests render both real source-facing regional overlays, in prepare and enable, with only
KSOPS generation omitted (no decrypt). They verify exact target/container identities, explicit
role references and empty opposite token, read-only CA, default closed creation, and preservation
of all unrelated resources/settings including existing static/auth/DSH configuration. This
source gate does not prove Secret existence/content, live production TLS, provisioning, DB
migration, GitOps/Argo convergence or production user acceptance; those are authorized rollout
steps in [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md).
