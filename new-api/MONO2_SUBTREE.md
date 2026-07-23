# mono2 NewAPI subtree workflow

`new-api/` is maintained as a squash-style subtree of
`https://github.com/QuantumNous/new-api.git`.

The initial import is pinned to the upstream revision recorded in
`.mono2-subtree`. That revision matches the NewAPI image that was running in
the Beijing and Shanghai LLMGateway environments when the subtree was added.

## Pull from upstream NewAPI

1. Inspect and choose the upstream revision deliberately. Do not move directly
   to the latest upstream revision as part of an unrelated product change.

2. Pull the selected upstream branch or revision into mono2:

   ```bash
   git subtree pull --prefix=new-api \
     https://github.com/QuantumNous/new-api.git main --squash
   ```

3. Update `new-api/.mono2-subtree` so `upstream_commit` matches the imported
   revision.

4. Keep these trailers on the mono2 import commit:

   ```text
   git-subtree-dir: new-api
   git-subtree-split: <imported NewAPI commit>
   ```

## Release boundary

`.ci/new-api.yml` builds and pushes NewAPI images to the Beijing and Shanghai
TCR repositories. It does not update GitOps manifests, create promotion
branches, or deploy either environment. Pinning a built image into LLMFleet is
a separate reviewed release action.
