# OpenCraft mono2 migration

`opencraft/` was imported with full Git history from
`git@git.woa.com:wisp/opencraft.git`. After this import, mono2 is the sole
write source for OpenCraft.

## Import provenance

- Source branch: `codex/mono2-migration-source`
- Source commit: `af7e7d04b271d788c8177aad411675dbe29f7172`
- mono2 base: `7f636c34d155f31bdfc6df4c7d83a3d36c5d11d3`
- Import commit: `327368646e4e4dda2505caa108736f2d2a58cdb6`
- Login migration-tail source/merge: `c3daab35df63fb3e083792cbbab4930cd4922f3c` / `5865a68a9796d5af2fcd61392bcb12d9a3934da8`
- Runtime migration-tail source/merge: `a3e981f543d3662616a72930d12c52cbaa9adccd` / `84625b756a13d6b78b109116d1de9f694ef39962`
- Host-catalog recovery source/merge: `4b0d4e6b51b323c75d89d80aed311c47b028e157` / `36a3eb0011a76e8670b48663a5dc661ca6942aa8` (upstream feature `7ff9f46a1128d5f4c406cb38a0a94b53390d706a`)
- Refreshed mono2 base: `a8d70ca376455e41a72d6efac680e9eaeb708ad4` (merged by `70d009c3e0b9598537c40bcbd7bd0eda11e43894`)
- Prefix: `opencraft`
- Commands executed during the bounded migration window:

  ```bash
  git subtree add --prefix=opencraft /vela codex/mono2-migration-source --no-squash
  git subtree pull --prefix=opencraft /vela codex/mono2-migration-source --no-squash
  ```

The source repository remains a read-only historical and rollback reference
until it is archived. The tail pulls above only captured edits explicitly
requested before migration handoff; they do not establish an ongoing sync contract.
Do not use routine `git subtree pull`, `git subtree split`, or dual-write
workflows for OpenCraft.

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
