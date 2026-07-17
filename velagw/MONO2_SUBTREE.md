# mono2 LLMGateway subtree workflow

`velagw/` is maintained as a squash-style subtree of
`git@git.woa.com:wisp/velagw.git`.

The squash model keeps the independent repository history out of mono2 while
preserving an explicit upstream commit for reproducible imports. Development,
tests, and review can happen directly under `mono2/velagw/`.

The initial import commit is published on the upstream ref recorded in
`.mono2-subtree`. Ongoing synchronization uses velagw `master` after those
changes land there.

## Pull from upstream velagw

1. Check the current upstream commit:

   ```bash
   git ls-remote git@git.woa.com:wisp/velagw.git refs/heads/master
   ```

2. Pull the upstream tree into mono2:

   ```bash
   git subtree pull --prefix=velagw \
     git@git.woa.com:wisp/velagw.git master --squash
   ```

3. Update `velagw/.mono2-subtree` so `upstream_commit` matches the imported
   velagw commit.

4. Keep these trailers on the mono2 import commit:

   ```text
   git-subtree-dir: velagw
   git-subtree-split: <imported velagw commit>
   ```

## Contribute mono2 changes back to velagw

1. Create a split branch from the subtree:

   ```bash
   git subtree split --prefix=velagw -b velagw/from-mono2-topic
   ```

2. Inspect the split branch, then push it to velagw:

   ```bash
   git log --oneline --decorate velagw/master..velagw/from-mono2-topic
   git push git@git.woa.com:wisp/velagw.git \
     velagw/from-mono2-topic:codex/from-mono2-topic
   ```

3. After the velagw MR lands, pull its master back into mono2 using the pull
   workflow above.

## Release boundary

The subtree imports source code and the upstream repository's deployment
definitions. It does not by itself register LLMGateway in mono2's unified
Argo/CD release manifests. Treat release migration as a separate reviewed
change.
