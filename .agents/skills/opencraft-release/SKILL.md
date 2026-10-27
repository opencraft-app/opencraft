---
name: opencraft-release
description: Prepare, validate, publish or recover an OpenCraft GitHub/npm release using the repository's exact-tag, exact-artifact workflow. Use for upstream release PRs, Actions publication and failed release recovery; not for deploying a downstream product.
---

# OpenCraft upstream release

Paths are relative to the standalone OpenCraft repository. Read `AGENTS.md`,
`SECURITY.md` and the public npm section of `docs/web-deployment.md`.
`docs/upstream-transition.md` records migration state; do not confuse a planned
upstream with a completed source cutover.

1. Fetch main and tags in a clean isolated feature checkout. Confirm the
   requested target repository, package and release scope. Never infer release
   permission from a request to build or deploy a downstream instance.
2. Preserve third-party copyright, license and required notices. Removing extra
   source comments or archives does not establish redistribution rights. Do not
   start implementation replacement work solely for a release, or claim that
   unresolved rights have been cleared. Scan the actual candidate/history with
   the verified Gitleaks version in the security workflow.
3. Prepare a release PR with a strictly increased stable version in
   `packaging/web-server/package.json` and its exact `## vX.Y.Z` section in
   `CHANGELOG.md`. Keep the lockfile in sync if the packaging contract changes.
   Run the affected product tests and the release workflow's local checks.
4. Merging that version change into main triggers `.github/workflows/release.yml`.
   It validates the release request and creates the exact tag, then packages once.
   The `npm-release` environment is restricted to main. Keep OIDC and the exact
   workflow filename; do not substitute a personal npm token or publish from a PR.
5. Follow the run through preflight, npm and GitHub Release. Report the tag/SHA,
   run URL, package/version, archive manifest and actual registry/install checks.
   A Git push, successful build or created tag is not a successful release.

For an existing stable tag, dispatch from main:

```sh
gh workflow run release.yml --repo opencraft-app/opencraft --ref main -f tag=vX.Y.Z
```

If publication may already have happened, inspect the exact npm version and
manifest before retrying. Rerun failed jobs on the original run to reuse the
verified artifact. Never rebuild an already-published version or move its tag;
byte mismatches require a new version. The secure-release kit under
`.github/secure-release/v1/` owns source/manifest/registry validation; test it
when changing that contract. Preserve old release assets and tags.
