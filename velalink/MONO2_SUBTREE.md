# mono2 velalink subtree workflow

`velalink/` is maintained as a mono2-integrated subtree of
`git@git.woa.com:wisp/velalink.git`.

The upstream history is rewritten before it is merged into mono2 because mono2
rejects commits whose author or committer does not belong to the mono2 account.
The original upstream commit is still recorded in `.mono2-subtree` so changes
can be contributed back to the real velalink repository.

## Pull from upstream velalink

1. Fetch the real upstream master:

   ```bash
   git ls-remote git@git.woa.com:wisp/velalink.git refs/heads/master
   ```

2. Clone upstream to a temporary directory and rewrite author/committer identity:

   ```bash
   rm -rf /tmp/velalink-rewrite-for-mono2-current
   git clone git@git.woa.com:wisp/velalink.git /tmp/velalink-rewrite-for-mono2-current
   cd /tmp/velalink-rewrite-for-mono2-current
   git checkout master
   FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch --force --env-filter '
   export GIT_AUTHOR_NAME="skipzhang"
   export GIT_AUTHOR_EMAIL="skipzhang@tencent.com"
   export GIT_COMMITTER_NAME="skipzhang"
   export GIT_COMMITTER_EMAIL="skipzhang@tencent.com"
   ' -- --all
   ```

3. Merge rewritten upstream into mono2 with subtree strategy:

   ```bash
   git remote add velalink-rewritten-current /tmp/velalink-rewrite-for-mono2-current
   git fetch velalink-rewritten-current master
   git merge -s recursive -Xsubtree=velalink --no-commit velalink-rewritten-current/master
   ```

4. Resolve conflicts by preserving mono2 integration changes unless the upstream
   change is intentionally replacing the mono2 adaptation.

5. Update `.mono2-subtree`:

   ```text
   upstream_original_commit=<real wisp/velalink master commit>
   upstream_rewritten_commit=<rewritten local master commit>
   ```

6. Commit the merge. Include both trailers:

   ```text
   git-subtree-dir: velalink
   git-subtree-split: <rewritten local master commit>
   Original-upstream-split: <real wisp/velalink master commit>
   ```

## Contribute mono2 changes back to upstream velalink

Use this when a change made under `mono2/velalink/` should become part of the
real `wisp/velalink.git` master.

1. Identify the upstream base recorded in `.mono2-subtree`:

   ```bash
   grep upstream_original_commit velalink/.mono2-subtree
   ```

2. Create a patch from the mono2 subtree against that upstream base:

   ```bash
   upstream_base="$(grep '^upstream_original_commit=' velalink/.mono2-subtree | cut -d= -f2)"
   tmp_upstream=/tmp/velalink-upstream-export
   rm -rf "$tmp_upstream"
   git clone git@git.woa.com:wisp/velalink.git "$tmp_upstream"

   # Export mono2 subtree content for comparison.
   tmp_tree=/tmp/mono2-velalink-export
   rm -rf "$tmp_tree"
   mkdir -p "$tmp_tree"
   git archive HEAD:velalink | tar -x -C "$tmp_tree"

   cd "$tmp_upstream"
   git checkout -b codex/from-mono2 "$upstream_base"
   rsync -a --delete "$tmp_tree"/ "$tmp_upstream"/
   git status --short
   ```

3. Review the diff carefully. Do not blindly upstream mono2-only integration
   files if they should stay local to mono2.

4. Commit and push in the real velalink repository:

   ```bash
   git add .
   git commit -m "..."
   git push -u origin codex/from-mono2
   ```

5. After the velalink MR lands, pull upstream back into mono2 using the pull
   workflow above, then update the `frontend` `velachat` pin when needed.

## Dependency pin

`frontend/package.json` consumes `velachat` from the real upstream repository,
not from the rewritten mono2 history:

```text
git+ssh://git@git.woa.com/wisp/velalink.git#<real upstream commit>
```

Do not pin `velachat` to a rewritten commit. Rewritten commits only exist to make
mono2 subtree history pass mono2 repository hooks.
