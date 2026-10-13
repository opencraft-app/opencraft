# Security

## Reporting a vulnerability

Send vulnerability reports privately to **masonxhuang@proton.me**. Include the
affected version or commit, reproduction steps, impact and a redacted diagnostic
sample. Keep credentials, private host addresses, user conversations and prompts
out of public issues, pull requests and Actions logs.

The current release and `main` are the active maintenance targets. Older releases
should be upgraded or assessed against the current code before reporting.

## Repository checks

- The `security` workflow scans every PR and main push with Gitleaks. PR dependency
  audits select changed npm installation roots; main pushes, weekly and manual
  runs audit all three roots. Managed Web regression/Playwright runs when update
  or deployment inputs change. The selection policy and stable aggregate checks
  are documented in [Build Matrix](docs/build-matrix.md#pull-request-ci-selection).
- Dependabot covers the root workspace, isolated DSH runtime, `hemesclient` and
  GitHub Actions. Credentials belong to a deployment user's private configuration.
- The CodeQL workflow analyzes JavaScript/TypeScript when the repository is public.
  Private repositories require the corresponding GitHub Code Security entitlement.
- `.gitleaks.toml` retains the default rules. Its only exception matches the two
  generated OpenAPI SHA256 assignments in their exact file; other values in that
  file remain scanned.

For local inspection, scan a clean export of the intended commit with Gitleaks
8.30.1 or newer, using this repository's configuration. Run `npm audit` in the root,
`runtime/dsh` and `hemesclient`; retain the findings and verify each lockfile is
unchanged. A failed audit is a finding, not a completed remediation.

## Publication boundaries

Public-release preparation includes source and Git-history secret scans,
author/committer identity checks, dependency findings, and the project's license
and third-party notices. A source scan does not erase historical data. Keep
machine deployment records in ignored `.local/`, and report any unverified steps.

Use an approved personal Git identity for new commits. Published-history cleanup
requires the repository owner's explicit authorization; ordinary commits and
pushes preserve history and repository visibility. A future public release must
resolve licensing and any retained company or private metadata first.
