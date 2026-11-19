# Join container runtime dependencies

`join-bake.hcl` builds the product-owned `Dockerfile.runtime-base` once and passes
it to the root-source Dockerfile as its `RUNTIME_IMAGE` named context. Gateway,
Brain, Hands and the full image all inherit Python 3 and the system CA bundle.
The Debian base remains pinned by digest. Role entrypoints and the non-root runtime user are unchanged. Historical
provenance is recorded separately from the current fork build identity.

This installs Python in the final runtime, not only in the Node build stage.
It supports existing product adapters and Python tools without installing
packages into a running container. It does not move execution between roles or
grant Gateway access to Hands resources.

Build through the clean committed standard-fork entry:

```sh
npm run ci:build:image -- gateway-brain
# Hands/all also require the verified custom Electron distribution documented
# by scripts/ci/build-image.sh.
```

The build entry checks Python standard-library imports and a nonempty default
TLS trust store inside every resulting image, as the image's configured user
with networking disabled. A missing interpreter, module or CA bundle fails the
build before image receipts are promoted. This check does not send email or
contact external services.

This is a private isolated candidate. Builds, publication and deployment were not
performed during the tooling migration. See
[the candidate contract](../docs/internal-distribution/standard-fork-candidate.md).
