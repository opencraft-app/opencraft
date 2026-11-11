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

The root workspace vendors `deepmerge` 4.3.1 as `vendor/deepmerge` version
4.3.2-opencraft.1 and pins it through a `file:` dependency and the
`$deepmerge` override. Upstream has not published a release after 4.3.1. The
backport writes `__proto__`, `constructor` and `prototype` keys as own data
properties, so a source object cannot change the merged object's prototype
([GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4)).
`npm ci`, the workspace dependency audit and Expo config resolution pass with
the vendored package, and the lockfile records the non-vulnerable version.
Remove the vendor copy once upstream publishes a fixed release or Expo stops
depending on `deepmerge`.

The DSH runtime still installs @deepseek-ai/dsh-client-connection 0.1.1-rc.2
([GHSA-8m2g-8cgm-3vcp](https://github.com/advisories/GHSA-8m2g-8cgm-3vcp)).
The advisory is fixed in 0.1.2-alpha.1, but every 0.1.2+ engine release also
requires the DSH engine migration: browser launch-token authentication for the
`/api` transport, Remote RPC names changed from dotted (`settings.describe`,
`session.history`, `credentials.*`, `llm.*`) to slash names, and `llm.*` no
longer exists. Engine 0.1.2-rc.1 crashes while watching `--patch` layers
because the Cordis HMR service is absent; 0.1.7-rc.2 removed
`ctx.jobs.onJobsChanged`, so the capability plugin cannot activate;
0.1.6-alpha.2 boots that plugin but rejects the existing dotted calls (401
without the launch token exchange, 404 after it). This finding is not
remediated and needs a coordinated engine migration rather than a
dependency-only update.

### Compatible dependency remediation (2026-11-07, updated 2026-11-11)

The root workspace overrides six transitive dependency lines to fixed
releases: `lodash-es` 4.18.1
([GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc),
[GHSA-xxjr-mmjv-4gpg](https://github.com/advisories/GHSA-xxjr-mmjv-4gpg))
below Mermaid's Chevrotain grammar packages; `nanoid` 3.3.20 and 5.1.16
([GHSA-28wg-ghj8-5hjv](https://github.com/advisories/GHSA-28wg-ghj8-5hjv),
[GHSA-2v37-7h3g-55p8](https://github.com/advisories/GHSA-2v37-7h3g-55p8),
[GHSA-mwcw-c2x4-8c55](https://github.com/advisories/GHSA-mwcw-c2x4-8c55) and
[GHSA-xwg4-73v4-xw9w](https://github.com/advisories/GHSA-xwg4-73v4-xw9w))
under Excalidraw and mermaid-to-excalidraw; `re2js` 2.8.7
([GHSA-gg6h-894w-4m9c](https://github.com/advisories/GHSA-gg6h-894w-4m9c))
under pi-interactive-shell; `undici` 8.12.3
([GHSA-2m5v-pch6-74hx](https://github.com/advisories/GHSA-2m5v-pch6-74hx) and
seven related HTTP, TLS, WebSocket and EventSource advisories) under the Pi
coding agent; the esbuild 0.18 line to 0.25.12
([GHSA-67mh-4wv8-2f99](https://github.com/advisories/GHSA-67mh-4wv8-2f99)) used
by Drizzle Kit's @esbuild-kit config loader; and `node-forge` 1.4.3
([GHSA-6889-vf6x-f3g5](https://github.com/advisories/GHSA-6889-vf6x-f3g5),
[GHSA-6cv4-p8m7-4r25](https://github.com/advisories/GHSA-6cv4-p8m7-4r25),
[GHSA-j8rw-jp99-435v](https://github.com/advisories/GHSA-j8rw-jp99-435v) and
[GHSA-w4xr-hqv8-ch44](https://github.com/advisories/GHSA-w4xr-hqv8-ch44))
below Expo CLI's code-signing certificate helper. The node-forge line moves
from the previously selected 1.4.1 to 1.4.3; the only consumer is
`@expo/code-signing-certificates`, and the patch release keeps that API. The
nanoid 4 to 5 and esbuild 0.18 to 0.25 overrides cross a major line; both
callers are checked against the selected release. nanoid 4 and 5 are ESM-only
and the consumers use only the named `nanoid` export; the loader uses the
stable `transform` and `transformSync` API.

`npm ci`, the root dependency audit and an OSV query over all 1,769
package/version entries in the root lockfile report no advisories. The
candidate passes the typechecks of the seven affected workspaces, the Pi
engine suite (78 tests), the structured-preview tests, the Web build
(including the Excalidraw and Mermaid dynamic imports) and the 1,038-file
browser compatibility check. A Node smoke parses a Mermaid diagram, generates
nanoid values, signs a SHA-256 digest with node-forge, compiles a RE2JS matcher
and loads the Drizzle config through the upgraded esbuild. No lock entries
outside the named lines changed except the in-range undici 7.30.2 patch and
the new esbuild platform binaries.

The isolated DSH runtime remains unremediated. The 2026-11-11 registry check
still finds 0.1.1-rc.2 as the newest release in the 0.1.1 line and 0.2.2-rc.1
as the newest published engine. The installed
`@deepseek-ai/dsh-client-connection` 0.1.1-rc.2 still serves the
`/api/events.mux` and `/api/events.host` downlinks used by
`apps/local-agent-host`; fixed engine releases changed that transport to the
launch-token/signed-cookie browser flow, so the engine migration described
above is still required.
