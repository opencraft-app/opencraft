---
name: opencraft-release
description: Prepare, publish or recover an OpenCraft app release (desktop, Android, iOS) through the App release workflow, beta or stable, with its exact-tag, exact-artifact checks. Use for release PRs, Actions publication and failed release recovery; not for deploying a downstream product.
---

# OpenCraft app release

Paths are relative to the standalone OpenCraft repository. Read `AGENTS.md`,
`SECURITY.md` and the release sections of `docs/develop/build-matrix.md`.
`docs/history/upstream-transition.md` records migration state; do not confuse a planned
upstream with a completed source cutover. The repository no longer publishes to
public npm; `.github/workflows/app-release.yml` is the only release publisher.

1. Fetch main and tags in a clean isolated feature checkout. Confirm the
   requested target repository, release scope and whether it is a beta or a
   stable release. Never infer release permission from a request to build or
   deploy a downstream instance.
2. Preserve third-party copyright, license and required notices. Removing extra
   source comments or archives does not establish redistribution rights. Do not
   start implementation replacement work solely for a release, or claim that
   unresolved rights have been cleared.
3. One product version covers every app. When it must change, open a PR that
   runs `node scripts/release/product-version.mjs set X.Y.Z` (it rewrites every
   source, including the lockfile) and, for a stable release, adds the exact
   `## vX.Y.Z` section to `CHANGELOG.md`. Betas of the next version use that
   version: `vX.Y.Z-beta.N`. Run the affected tests and
   `node scripts/release/product-version.mjs check`.
4. After it merges, dispatch the release from main. `publish=false` builds and
   verifies every package without creating the tag or release:

   ```sh
   gh workflow run app-release.yml --repo opencraft-app/opencraft --ref main -f tag=vX.Y.Z-beta.N -f publish=true
   ```

   A beta becomes a GitHub pre-release. A stable `vX.Y.Z` additionally runs the
   performance gate, opens with its changelog section and becomes the latest
   release. Every release uploads the same commit to TestFlight without waiting
   for beta review.
5. Follow the run through every platform job, staging and publication. Report
   the tag/SHA, run URL, release URL, the manifest's artifacts and the TestFlight
   build number. A Git push, successful build or created tag is not a successful
   release; a TestFlight upload is not availability until Apple approves it.

If publication may already have happened, inspect the release and its
`release-manifest.json` before retrying. Rerun failed jobs on the original run
to reuse the verified artifacts. Never rebuild an already-published version or
move its tag; byte mismatches require a new tag. The secure-release kit under
`.github/secure-release/v1/` owns changelog extraction and manifest validation;
test it when changing that contract. Preserve old release assets and tags.
