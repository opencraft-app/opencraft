# OpenCraft mono2 migration

`opencraft/` was imported once, with full Git history, from
`git@git.woa.com:wisp/opencraft.git`. After this import, mono2 is the sole
write source for OpenCraft.

## Import provenance

- Source branch: `codex/mono2-migration-source`
- Source commit: `af7e7d04b271d788c8177aad411675dbe29f7172`
- mono2 base: `7f636c34d155f31bdfc6df4c7d83a3d36c5d11d3`
- Import commit: `327368646e4e4dda2505caa108736f2d2a58cdb6`
- Prefix: `opencraft`
- Command:

  ```bash
  git subtree add --prefix=opencraft /vela codex/mono2-migration-source --no-squash
  ```

The source repository remains a read-only historical and rollback reference
until it is archived. Do not use routine `git subtree pull`, `git subtree
split`, or dual-write workflows for OpenCraft.

## Shared frontend boundary

OpenCraft currently consumes a bounded closure of Agent Console source from
the sibling `frontend/` service through
`scripts/sync-mono2-agent-console.mjs`. The generated compatibility copy is
kept temporarily so Web, Expo, Electron, and extension builds remain
independent while stable cross-platform packages are extracted.

- Default source: `mono2/frontend/src`
- Generated target: `opencraft/plugins/lightvela-hermes/src/upstream/mono2`
- Drift check: `cd opencraft && npm run check:mono2-agent-console`
- Regenerate: `cd opencraft && npm run sync:mono2-agent-console`

The manifest records a repository-relative source and the latest commit that
touched the shared frontend paths. It must never record a developer worktree
path. Generated files are not edited by hand.

Long term, move stable UI primitives, domain contracts, and repository
interfaces into explicit workspace packages. Delete each vendored slice only
after all OpenCraft targets consume the package and the full gate passes.
