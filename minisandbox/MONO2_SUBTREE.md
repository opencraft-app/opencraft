# mono2 minisandbox subtree workflow

`minisandbox/` entered mono2 as a squash-style subtree from the independent
minisandbox Git history. The source revision is
`fc637a82b717e3d5a664154e93341e0bc6a29679`. The import uses the root snapshot
commit `777fae776a30051f1112c6b5b54f17d63e086e31`, which differs only by removing
the mistakenly tracked runtime log `coscli.log`. The import commit carries the
standard `git-subtree-dir` and `git-subtree-split` trailers for that safe
snapshot.

The independent repository had no configured remote at import time. Do not
invent a remote URL or imply that another server contains this exact history.
After this import, mono2 is the source of truth and normal development happens
directly under `mono2/minisandbox/`.

## Import a deliberate legacy revision

Only use this path when a reviewed change still exists solely in a preserved
clone of the old repository. First construct and inspect a root snapshot that
excludes generated logs, credentials and build output, then import its full
commit ID:

```bash
git subtree pull --prefix=minisandbox \
  /path/to/preserved/minisandbox <safe-snapshot-commit> --squash
```

Update `.mono2-subtree` with both the reviewed source commit and safe snapshot
commit. Retain these trailers on the squash commit:

```text
git-subtree-dir: minisandbox
git-subtree-split: <safe snapshot commit>
```

Never pull an implicit branch tip from the legacy clone. Select and review the
full source commit and exclusions first, and perform the operation from a clean
isolated worktree.

## Export a standalone tree

If an independent minisandbox repository is needed again, derive it from the
mono2 source of truth:

```bash
git subtree split --prefix=minisandbox -b minisandbox/from-mono2
```

Inspect that branch before publishing it to any newly approved remote.

## Release boundary

The subtree import moves source ownership only. It does not publish runtime
images, update Argo desired state, or change any production Cell. Those remain
separate reviewed release operations with their existing qualification gates.
