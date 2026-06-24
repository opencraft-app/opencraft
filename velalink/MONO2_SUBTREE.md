# mono2 velalink subtree workflow

`velalink/` is maintained as a mono2-integrated subtree of
`git@git.woa.com:wisp/velalink.git`.

The upstream `velalink` repository is intentionally normalized to the same
author and committer identity accepted by mono2. That keeps the long-term flow
close to a normal subtree workflow: mono2 can pull upstream history directly,
and changes made under `mono2/velalink/` can be split back into an upstream
branch when they should become part of `velalink`.

## Pull from upstream velalink

1. Check the current upstream master:

   ```bash
   git ls-remote git@git.woa.com:wisp/velalink.git refs/heads/master
   ```

2. Fetch upstream into mono2:

   ```bash
   git remote add velalink git@git.woa.com:wisp/velalink.git
   git fetch velalink master
   ```

   If the remote already exists, only run `git fetch velalink master`.

3. Merge upstream into the subtree:

   ```bash
   git merge -s recursive -Xsubtree=velalink --no-commit velalink/master
   ```

4. Resolve conflicts by preserving mono2 integration changes unless the upstream
   change intentionally replaces the mono2 adaptation.

5. Update `.mono2-subtree`:

   ```text
   upstream_commit=<current wisp/velalink master commit>
   ```

6. Commit the merge. Include these trailers when useful:

   ```text
   git-subtree-dir: velalink
   git-subtree-split: <current wisp/velalink master commit>
   ```

## Contribute mono2 changes back to upstream velalink

Use this when a change made under `mono2/velalink/` should become part of
`wisp/velalink.git`.

1. Create a split branch from the subtree:

   ```bash
   git subtree split --prefix=velalink -b velalink/from-mono2-topic
   ```

2. Inspect the split branch before pushing:

   ```bash
   git diff --stat velalink/master velalink/from-mono2-topic
   git log --oneline --decorate velalink/master..velalink/from-mono2-topic
   ```

3. Push the split branch to upstream:

   ```bash
   git push git@git.woa.com:wisp/velalink.git \
     velalink/from-mono2-topic:codex/from-mono2-topic
   ```

4. After the velalink MR lands, pull upstream back into mono2 using the pull
   workflow above, then update the `frontend` `velachat` pin when needed.

## Dependency pin

`frontend/package.json` consumes `velachat` from the real upstream repository:

```text
git+ssh://git@git.woa.com/wisp/velalink.git#<upstream master commit>
```

Keep this pin aligned with `.mono2-subtree` when mono2 needs the latest
`velalink` runtime behavior.
