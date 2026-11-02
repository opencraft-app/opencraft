# Security

## Reporting a vulnerability

Report vulnerabilities privately through the repository's GitHub private security advisory (Security → Advisories → Report a vulnerability). Include the
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
- Dependabot covers the root workspace, isolated DSH runtime, `apps/bridges/hermes` and
  GitHub Actions. Credentials belong to a deployment user's private configuration.
- The CodeQL workflow analyzes JavaScript/TypeScript when the repository is public.
  Private repositories require the corresponding GitHub Code Security entitlement.
- `.gitleaks.toml` uses the default rules without repository-specific exceptions.

For local inspection, scan a clean export of the intended commit with Gitleaks
8.30.1 or newer, using this repository's configuration. Run `npm audit` in the root,
`runtime/dsh` and `apps/bridges/hermes`; retain the findings and verify each lockfile is
unchanged. A failed audit is a finding, not a completed remediation.

### Outstanding dependency findings (2026-10-13)

Compatible dependency updates clear the isolated DSH runtime audit. The root
workspace audit still reports high-severity findings from `braces@3.0.3`
([GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)) and
`node-forge@1.4.0`
([GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv)),
including their dependent packages. Neither package has a patched release at
the time of this check. npm's suggested Expo major downgrade is not a compatible
fix for the current Expo/React Native stack. Lower-severity findings also remain;
rerun `npm audit` for the current inventory. These findings are not remediated.
The upstream CI policy below determines whether findings block integration.

### Upstream audit policy (2026-10-18)

Dependency vulnerability findings are advisory rather than integration blockers
under the owner's current migration decision. This policy is independent of
repository visibility. The security workflow runs the full audit at each
selected installation root and retains its complete JSON report for three days.
The Actions summary explicitly identifies advisory findings as unresolved.
Registry errors, invalid reports, failed installations and lockfile changes
still fail. Secrets scans, managed Web regressions and required aggregate checks
remain mandatory. No dependency versions or advisory records are hidden.

Local invocation defaults to the existing high-severity failure threshold;
`NPM_AUDIT_REPORT_ONLY=true` explicitly selects advisory output. CI keeps that
mode when the upstream becomes public. No findings are represented as fixed.
Source cleanup was removed from the upstream migration prerequisites, and a later
provenance scan and de-sensitization pass removed internal host, contact and
identity references from the public tree. That pass neither cleared nor rewrote
source records and notices.

### Compatible dependency remediation (2026-10-17)

The lockfile now selects DOMPurify 3.4.17 and shell-quote 1.12.0 within
their existing dependency ranges. Hermes selects fflate 0.4.9, a patch in its
existing 0.4 series; its generated gzip consumer is unchanged. These versions
address [DOMPurify rawtext](https://github.com/advisories/GHSA-6688-9rhm-gjv2),
[DOMPurify detached hooks](https://github.com/advisories/GHSA-p98j-92pf-mc4p),
[fflate ZIP64 parsing](https://github.com/advisories/GHSA-px8p-9vwx-vf98) and
[shell-quote line terminators](https://github.com/advisories/GHSA-pqg4-j6r4-53mv).
Updating a library does not establish that the product used the vulnerable
configuration. The root audit still has other findings and remains a failing
release check; no exception, framework downgrade or provenance clearance is
implied. Audit the exact candidate and all its workspace manifests rather than
comparing counts from different source trees.

### Compatible dependency remediation (2026-10-18)

A further update within the existing dependency ranges selects brace-expansion
1.1.21, 2.1.7 and 5.0.12, fast-uri 3.1.8, http-cache-semantics 4.3.0,
undici 6.29.1 and 7.30.1, and react-router 7.18.4. The exact candidate audit
no longer reports those five package names. No unrelated lock entries, framework
versions or audit rules are removed. These changes require the original routing,
HTTP, packaging and cross-platform regression checks before delivery.

The root audit still fails: the candidate has 70 affected package entries
(3 low, 16 moderate, 51 high, no critical), compared with 75 on its exact base.
These counts include dependent packages and are not counts of independent
vulnerabilities. The unresolved braces/node-forge findings remain in force;
sharp outside the existing 0.34 dependency line requires separate compatibility
assessment. This update neither clears provenance nor authorizes publication.

## Publication boundaries

Public-release preparation includes source and Git-history secret scans,
author/committer identity checks, dependency findings, and the project's license
and third-party notices. A source scan does not erase historical data. Keep
machine deployment records in ignored `.local/`, and report any unverified steps.

Use an approved personal Git identity for new commits. Published-history cleanup
requires the repository owner's explicit authorization; ordinary commits and
pushes preserve history and repository visibility. The owner has authorized the
canonical GitHub public cutover, with the previous repository retained as a
private archive. Do not expose credentials or account data.

### Image packaging dependency remediation (2026-10-18)

The separately assessed direct development dependency Sharp moves from 0.34.5
to 0.35.5, retaining its no-install-script policy and the existing image
optimizer. The exact candidate audit no longer reports Sharp; it still fails
with 69 affected package entries (3 low, 16 moderate, 50 high, no critical).
These are associated dependency records, not independent vulnerability counts.
No audit rule, framework dependency or unpatched finding is exempted.

Compatibility checks exercise PNG pixels/alpha, JPEG orientation, WebP format
and dimension limits, non-enlargement and corrupt-input failure under build
and release Node runtimes. Original product image sources remain unchanged;
actual copied-asset comparisons distinguish encoded-byte differences from
decoded-pixel differences. Public release, provenance and upstream acceptance
remain separate checks.

### Dependency security updates (2026-11-02)

The root workspace overrides body-parser 2.4.0, qs 6.16.1, node-forge 1.4.1,
zod 4.6.6, @hono/node-server 2.1.3, fast-uri 3.1.9, hono 4.13.11, ip-address
10.7.4, minimatch 11.0.1, glob 14.0.2 and katex 0.19.0. The isolated DSH runtime
selects body-parser 2.4.0, qs 6.16.1, zod 4.6.6, fast-uri 3.1.9,
@hono/node-server 2.1.3, hono 4.13.13 and ip-address 10.7.4. The desktop
toolchain moves Electron to 44.9.1 and @electron/universal and @electron/asar
to 3.0.6 and 4.3.1. The major updates are exercised by workspace typechecks and
the connector, MCP-app and DSH bridge suites.

The root audit still reports deepmerge 4.3.1
([GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4))
because no patched release exists and the current Expo configuration keeps it.
The DSH runtime still installs @deepseek-ai/dsh-client-connection 0.1.1-rc.2
([GHSA-8m2g-8cgm-3vcp](https://github.com/advisories/GHSA-8m2g-8cgm-3vcp));
the fix first appears in 0.1.2-alpha.1 and the 0.2 release line, which requires
a separate DSH engine upgrade. Neither finding is represented as remediated.
