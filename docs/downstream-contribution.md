# Contributing a downstream change upstream

Contributors use their normal downstream SSH branches and review system. A
maintainer exports the reviewed reusable change into a **separate clean public
checkout**; no downstream commits, parents, identity translations, gateway, or
private fork are required on GitHub.

Use Python 3, Git, gitleaks (with its `dir` command), and an authenticated `gh`.
Start from a concrete downstream base and contribution head. List exact files,
not directories or glob patterns:

```sh
python3 scripts/contribute-upstream.py prepare \
  --source /path/to/downstream --base BASE_SHA --head CONTRIBUTION_SHA \
  --destination /path/to/new-public-checkout \
  --repo opencraft-app/opencraft --branch contrib/reusable-change \
  --gitleaks /path/to/gitleaks --name 'Contributor' --email contributor@example.com \
  --message 'fix: reusable change' \
  --co-author 'Original Contributor <contributor@example.com>' \
  --path packages/core/src/example.ts
```

The command applies only the selected delta on current public `main`, scans the
selected contents and commit message using an explicit default-rules scanner
configuration outside the payload, with no ignore files or inline allow comments,
and creates one commit whose only parent is public
main. Context conflicts stop the export; resolve them deliberately in a new
candidate rather than copying private files wholesale. Symlinks, submodules,
private/configuration paths, arbitrary refs and directory selection are refused.
A failed prepare may leave its destination for diagnosis; choose a new empty
path for a retry.

The receipt sits **outside** the public checkout and contains private source
identifiers. Do not publish it. Review `git show HEAD` in the public checkout,
verify ownership/licensing and internal-information boundaries, and run relevant
tests. Secret scanning is only one guard and is not a privacy or correctness
proof. The schema-2 `approval_sha256` binds the exact public diff, repository, branches,
public parent, candidate commit and expected remote head. It is not an automatic
approval. Review original authorship and use `--name`/`--email` for the intended
author, or repeat `--co-author 'Name <email>'` with permission to publish those
identities. Internal email addresses are never copied automatically.

```sh
python3 scripts/contribute-upstream.py publish \
  --receipt /path/to/new-public-checkout.contribution.json \
  --approve-sha256 REVIEWED_APPROVAL_SHA256 \
  --gitleaks /path/to/gitleaks \
  --title 'fix: reusable change' --body-file /path/to/public-pr-body.md
```

Publication rechecks cleanliness, commit, public-parent ancestry and approval
digest, and repeats the trusted secret scan. It uses the
legitimate `gh` credential helper, pushes only the public candidate branch, and
creates (or finds) its PR. It never pushes a private branch or rewrites upstream
main. Normal GitHub protections and reviews still apply.

After upstream merges, fetch public main into the downstream fork and integrate
it using the existing downstream merge workflow. Do not replay the exported
change a second time. A squash PR has a different commit ID: compare content and
resolve the integration normally; this helper does not claim automatic
bidirectional history reconciliation. Keep the private receipt as the local link
between downstream head, public commit and PR. If the downstream change mixes
private and generic edits within a file, split/sanitize it before exporting.

## Updating the same PR safely

Prepare a fresh candidate directory using the same source base, the revised
source head and the same `contrib/*` branch. Add
`--previous-receipt /path/to/previous-checkout.contribution.json`. Review the new
candidate and approve its **new** `approval_sha256`. Old schema-1 receipts can
identify the previous remote commit during migration, but cannot authorize a
publication themselves.

The previous receipt must match the actual remote branch head. Publication uses
an exact `--force-with-lease=refs/heads/contrib/...:PREVIOUS_SHA` because the
one-commit candidate is intentionally regenerated on public main. A concurrent
writer causes refusal, never a blanket force overwrite. Repeating publication of
the same candidate is safe. Closed/merged PRs, a different PR base, or a changed
remote head require explicit reconciliation or a new contribution branch; they
are not reported as success.

Only `contrib/*` refs may be published. GitHub main/master/release branches are
not publication destinations. Source receipts stay private and outside the
checkout. This is an operator-reviewed workflow, not an authorization boundary
against an attacker who controls the operator's executable, scanner or local
checkout.

## Regression tests

```sh
GITLEAKS_TEST_BIN=/path/to/gitleaks python3 -B -m unittest discover \
  -s scripts/tests -p test_contribute_upstream.py
```

The security workflow runs these tests after installing its checksum-verified
scanner. Local Git transaction tests cover initial publication, review updates,
idempotent retries, concurrent-writer refusal, and a modeled upstream squash plus
normal downstream merge. This local model is not a claim that a production PR
has already merged back. Semantic conflicts still require human resolution.
