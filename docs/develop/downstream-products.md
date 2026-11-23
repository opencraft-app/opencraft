# Building a downstream product

A downstream product builds on OpenCraft as a **Git downstream**: its repository
contains the public core history plus its own product assembly (identity,
branding, enterprise services and deployment configuration). Core stays one
writable codebase upstream; the product should add assembly and not quietly
change shared core. The boundary audit below turns that rule into a check.

## Git model: merge upstream, never squash

- Start the product repository from a public commit (fork or clone with full
  history) and keep the public repository as a remote, for example `upstream`.
- Take new core by `git fetch upstream` and a normal merge of `upstream/main` or a
  release tag. Do not squash, rebase or copy core files into an unrelated
  history: the audit uses `git merge-base` to know which core the product really
  contains, and a squashed copy has no shared history.
- Resolve merge conflicts in product files. A conflict in a core file means the
  product changed core; prefer moving that change upstream (see below) over
  keeping the patch.
- Never rewrite published core history, generated contracts or published SQLite
  migrations downstream to make a diff smaller.

## Product workspace layout

Keep product assembly under one or more product roots that do not exist
upstream, for example `products/<product>/`. A product root is its own npm
project (own `package.json`, lockfile and checks) layered on the core install, so
the root `package.json` and `package-lock.json` remain byte-identical to upstream.
Product plugins, packages, native shells, deployment kits and tests live there
too. Private operating notes for the fork can live in `.agents/fork/AGENTS.md`
(see [AGENTS.md](../../AGENTS.md)) or another private prefix.

Select product compositions through the explicit entry points core documents
(for example in the [build matrix](build-matrix.md)); do not add private
workspaces, scripts or dependencies to core manifests.

## Consume public package entry points only

Import core through package names and their declared `exports`, for example
`@opencraft/<package>` or a documented subpath. Do not reach into another
package's `src/` with relative paths, and do not copy a core file to change it
locally: a copy silently drifts from core because path-based review cannot see
it. If an entry point you need is missing, add it upstream.

## Running the boundary audit

The audit is [`scripts/release/downstream-boundary.py`](../../scripts/release/downstream-boundary.py)
(Python 3 and Git only). Copy
[`downstream-boundary.example.json`](../../scripts/release/downstream-boundary.example.json)
into the product repository, adjust it, and run from the product checkout:

```sh
git fetch upstream
python3 scripts/release/downstream-boundary.py \
  --policy path/to/downstream-boundary.json \
  --upstream-ref upstream/main \
  --report /private/path/boundary-report.json
```

- The base defaults to `git merge-base <downstream> <upstream-ref>`: the newest
  upstream commit the product actually merged, so unmerged upstream work is not
  reported. No merge base, or more than one, fails (exit 2); pass
  `--upstream <commit>` to compare an exact pair instead. `--downstream`
  defaults to `HEAD`.
- Only committed trees are read; the working tree, index and remotes are never
  used or changed.
- Exit `0`: every difference is approved. Exit `1`: pending differences remain.
  Exit `2`: the audit itself failed (bad policy, missing commit, no shared history).
- stdout is a one-line JSON summary. The `--report` file adds the `approved`,
  `pending`, `core_deep_import_sites` and `core_near_duplicate_sites` lists. It
  names private paths and object IDs; keep it private.

### Policy

| Key | Meaning |
| --- | --- |
| `schema` | `1` |
| `product_roots` | Directory prefixes (ending in `/`) holding product code; scanned for size, deep imports and copies. May be empty. |
| `core_source_globs` | Core internals that product code must not import relatively, e.g. `packages/*/src/**`. |
| `core_duplicate_globs` | Core files compared against product files for near-copies, e.g. sources, `tests/**`, `deploy/**`. |
| `private_only_prefixes` | `{prefix, reason}`: downstream-only paths under the prefix are approved. A prefix never approves a path that also exists upstream. |
| `pinned_differences` | `{path, upstream_entry, downstream_entry, reason, upstream?}`: one reviewed shared-file difference. Entries are `MODE TYPE OID` exactly as `git ls-tree` prints them, or `null` for absent. Changing either side expires the pin. |
| `require_pinned_upstream` | Optional boolean. When true, every pin needs `upstream`: an `https://` pull-request URL or `"none: <reason>"`. |

Globs are rooted at the repository; `*` and `?` match within one path segment,
and a whole `**` segment matches any depth (a trailing `/**` also matches the
directory itself). Unknown keys, unsafe paths and duplicate rules fail the audit.
Do not generate pins by copying every current diff into the policy: each pin is a
reviewed decision with a reason. `unused_pins` in the summary lists pins that no
longer match and can be deleted or re-reviewed.

### Metrics

Metrics are tracked as numbers for the recorded commit pair; they never change
the exit code.

| Metric | Meaning | Target |
| --- | --- | --- |
| `pinned_shared_file_exceptions` | Shared core files changed through an approved pin | 0 |
| `private_prefix_files` | Downstream-only files per private prefix (every prefix listed) | Informational |
| `core_deep_imports` | Relative JS/TS `import`/`export from`/`import()`/`require()` specifiers in product code (outside `scripts/` and `tests/` directories) resolving into `core_source_globs` | 0 |
| `downstream_only_outside_private_prefixes` | Added files not covered by any private prefix | 0 (otherwise pending) |
| `private_product_lines` | `{code, tests}` line counts of product JS/TS, Python, shell, YAML and Dockerfiles, excluding `migrations/`, `*.generated.*` and lockfiles | As small as the assembly allows |
| `core_near_duplicates` | Product files of at least 150 tokens whose tokens are at least 80% similar to a core file with the same name and language under `core_duplicate_globs` | 0 |

Near-duplicate detection tokenizes each language simply: comments (`//` and
`/* */` for JS/TS, `#` for Python, shell, YAML and Dockerfiles), whitespace, quote
style and `;`/`,` separators are ignored, so a reformatted copy still counts.
Product tests are scanned too, which catches stale copies of core tests. The
deep-import scan is lexical and covers relative specifiers only.

## Contribute generic work upstream first

When product work needs a core change (a new extension point, a missing package
export, a bug fix, a reusable deployment option), land it upstream as a normal
pull request, then merge the release back into the product. See
[Contributing a downstream change upstream](downstream-contribution.md) for a
tool that exports selected downstream changes to a clean public branch. Keep a
temporary pin only while that pull request is open, and record its URL in the
pin's `upstream` field.
