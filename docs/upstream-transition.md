# Upstream transition

The target upstream is [opencraft-app/opencraft](https://github.com/opencraft-app/opencraft).
Core development, public issues, pull requests, CI and releases belong there.
Downstream products consume immutable source revisions and own their product
composition. This replaces the previous mirror direction.

The upstream source cutover is **operational**: the complete core was
accepted through the original protected PR, private product composition was
moved downstream, and downstream now consumes an immutable accepted source
revision. General core improvements are contributed through GitHub PRs;
downstream owns its pin, product assembly and recorded patches, so its delivery
does not depend on upstream PR acceptance. The owner has authorized the canonical public cutover and explicitly removed
source cleanup from this migration. A real npm publication remains deferred;
it is not a prerequisite for the GitHub source upstream.

On 2026-10-27, the owner authorized another repository-history reset. The
canonical address is served by a new independent repository with one initial
commit, based on `b9b19483b4a16fc13e03b18a807120af3c9f06a4` (tree
`f8e5834558642c81c906ce7735687eec4c8acb3c`). The previous canonical repository,
including its branches, pull requests and Actions history, is retained at
[opencraft-history-20261027](https://github.com/opencraft-app/opencraft-history-20261027).
The source implementations and required notices are preserved; only these
repository-history documents change. Old revision pins and pull-request links
must use the archive identity. The original private archive remains intact.
This cutover does not publish npm packages or deploy downstream services.

On 2026-10-18, the owner approved retaining the original repository as the
private history archive
and establishing clean history at the canonical address. Initial commit
`527f579d95ff236739f8c09902db2728d86e7c7b` has the same accepted 3400-file tree
`b1366cf67fa0bb02d21b7c5ecb087eb9cff7e19a`, with complete Web/Electron/Expo
clients. The old accepted PR #32 and its commits/tags/releases belong to the
archived repository identity; do not interpret old canonical links as commits
in the new history. Existing runtime owners and data are preserved. This records
the migrated downstream consumer, not completion of every legacy downstream
baseline. Each remaining migration must preserve its own behavior, adopt a fixed
source plus recorded patches, and verify reconstruction and product integration;
do not establish a second writable core.

## Ownership

| Upstream core | Downstream product |
| --- | --- |
| Actor identity, verified identity bindings, authorization, audit, Hub routing | enterprise identity verification, employee fields, enterprise avatar service |
| Local/OIDC account adapters and public identity/execution ports | the downstream product account, billing, Bot discovery and cloud-service/Hermes composition |
| Chat, Composer, timeline, design tokens, public Web/Electron/Expo clients | managed site branding/navigation and the downstream product native/embedded product entrypoints |
| Public build/release tools and contribution/maintenance skills | Internal deployment, release channels, business service config and integration ledger |

A private provider establishes verified identity; core owns membership and
resource authorization. Removing a configured provider must fail closed.
Private startup code is supplied by a product composition root, not imported
unconditionally by a public Application or hidden only behind a menu flag.
Public clients must remain useful clients, not empty replacements for the
private product. Native product code must still be packaged, not fetched as
remote executable code.

## Boundary migration record and remaining review

Product native-audio bridge globals and authenticated speech HTTP adapters are
owned by downstream composition, together with their native/protocol/browser
regressions. Core retains `AudioCapturePort`, `SpeechServicePort`, the cloud speech
input provider and Composer's transient-input ownership. The shared workbench
does not choose product speech routes, a fixed product model or a product bridge
global. Removing these adapters does not change the reusable public speech-model
configuration or public Hunyuan provider.

Product-only embedded draft heading decoration, including narrow and short
container rules, is owned by the downstream embedded composition. It reuses the
original ShadowRoot stylesheet assembly and resource URL. Public shared styles
no longer reserve that product artwork space or reference its image.


The work-status diagnostic exercises current production components without a
separate source snapshot. Browser evidence uses system temporary directories.
External execution-runtime checks and connector catalog exports still require
explicit local inputs. See
[developer inputs](build-matrix.md#developer-diagnostics-and-browser-evidence).

Host-specific Composer shortcut declarations and standalone action adapters belong
to the trusted connection provider. Core matching, presentation and resident
Host/profile/provider lease checks are engine-neutral; the downstream engine
retains its existing wire behavior. The Composer Stop button and ordinary
submission/queue ownership are unchanged.

Bot-management provider eligibility and product empty states are declared by the
trusted client product. Core selects among eligible enabled profiles using actual
directory capabilities, without interpreting a private provider ID or account.
Ambiguity does not choose a Host; selection/profile replacement retires old reads
without remounting operation drafts. This cut does not grant backend permissions
or establish that every consumer/build edge has been reviewed.

Product Bot Create-return and optional native Cron probes belong with their
downstream builders and generated assets. Public Expo scripts do not consume
those private artifacts. The original assertions stay in the product workspace;
this migration does not claim a device/native build or change application behavior.

- Workbench tool navigation and standalone management routes consume each page's
  `management.entryPoint` declaration. Core no longer recognizes private Skills
  or Storage page IDs; their product owns the explicit declaration. Contextual
  management remains the default, and the shell retains route and layout
  ownership. Language, platform, audience and extension retirement are shared
  contribution projections rather than product-specific branches.

- Electron Main/Preload select explicit, paired local desktop product entries.
  Default public bundles no longer include the private product login, account
  HTTP implementation, session store or preload account namespace. The original
  implementation and compatibility channels belong to the downstream desktop
  composition. Core retains profile/protocol/window ownership, early callback
  routing and current-frame IPC admission; product disposal retires its handlers.
  See [desktop product composition](desktop-product-composition.md). JS closure,
  preload and lifecycle checks do not claim OS or external-login acceptance.
- Public Application lifetime, optional-builtin and plugin-Settings browser probes
  no longer assume the removed private bootstrap options or an automatically
  installed product. Default startup is tested without a product; explicit product
  behavior uses a local `ClientWorkbenchProduct` fixture. Chromium checks cover
  persisted enablement, protected bundled sources and consumer-before-product
  teardown, including startup rollback. Other product-specific probes must still
  be reviewed against their actual entrypoints; passing these probes does not
  establish that all public development commands are independent.
- The embedded-navigation browser probe supplies a synthetic navigation policy
  through the core `BrowserNavigationPolicy` port. It no longer imports the
  removed private bootstrap or relies on product hostnames. Real link clicks,
  allowed iframe destinations, external opener isolation, lookalike rejection
  and retained drafts remain covered; this is not a live product login check.
- The cross-Hub transport probe composes its local gateway identity through the
  public Relay adapter port, replacing the removed private enterprise identity configuration.
  Real Chromium still crosses two TLS-connected Hubs, rejects anonymous identity,
  checks target membership and observes live revocation; the transit Relay uses
  the unmodified public artifact. These identities and target content are fixtures.
- Removed product Collaboration sources and their snapshot checks do not define
  a current core capability. Historical migration evidence remains with the
  downstream archive; product removal is not a claim that Actor/Hub messaging
  has been implemented.
- Web Application/Supervisor now consume the trusted `@opencraft/client-product`
  lifecycle rather than creating a downstream product account. The public entry selects no
  private product. Downstream explicitly selects a local composition using
  `OPENCRAFT_CLIENT_PRODUCT_ENTRY`; the private client package owns early login
  callbacks, one account, ordered platform/Hermes activation, embedded preflight
  and its declared optional features. Its borrowed cache port preserves
  product credential namespaces and profile hydration behavior. The private client
  and optional product plugin sources, manifests and tests are downstream-owned in
  `products/<product>/plugins`; the public workspace no longer installs those packages.
  Platform/Hermes and the account SDK now live in downstream `products/<product>`
  as well. Public workspace manifests and locks no longer install those six
  private runtime/snapshot packages; this does not resolve source provenance.
- The private embedded element, account/physical-connection adapter, root and
  integration tests live in downstream `products/<product>`. The trusted build owner
  selects its local entry with `OPENCRAFT_EMBEDDED_PRODUCT_ENTRY`; default public
  Web/Electron builds have no embedded product input or loader. Explicit product
  builds retain the existing element API and loader URL. An embedded-only build
  without an explicit entry fails instead of producing an empty replacement.
  Generic paint, prompt, panel, audio and connection helpers remain core. The
  Web application manifest no longer depends on the downstream product plugins. Original native
  product sources and private package entities are owned downstream. Original
  private probes and synchronizers are now downstream-owned as well; core has
  no private CLI compatibility imports. Generic approval/extension behavior
  checks and dependency boundary rules remain public. Private static assets are now selected
  explicitly through the trusted local product public directory. Web build policy,
  checker and release aliases are downstream-owned: product configs compose the
  core Vite factory rather than making a product label select private defaults.
  Existing CI and native Bot generators explicitly select their product config.
- the managed site's brand package, artwork, original generation tool and product browser
  assertions are downstream-owned. Its explicit client entry adds the original
  managed builtin to the existing product lifetime, after deployment defaults
  resolve. Core has no managed site package dependency or unconditional manifest import;
  generic branding/extension support remains public. The product Vite config
  serves/copies its own plugin assets at the original URLs.
- Server-backed Web accepts trusted extension factories. The default server
  extension entry is empty; a downstream build explicitly selects its local
  assembly with `OPENCRAFT_SERVER_EXTENSIONS_ENTRY`. Headless alone no longer
  selects enterprise identity. This removes that assembly edge, not the remaining the downstream product
  imports or private plugin/package dependencies. Browser compatibility analysis
  follows the actual runtime graph across the workspace boundary, so moving
  product sources outside the prefix does not silently drop typed API checks.
  Trusted external sources can resolve public core dependencies from this build's
  workspace after their own valid dependencies; Web keeps existing React dedupe.
  Headless and Relay use a workspace dependency fallback as well. The typed checker retains
  imported core API types and rejects unresolved runtime TypeScript modules.
  These mechanisms are verified with external build fixtures; they do not by
  themselves move the remaining private plugins or prove their physical extraction.
- Headless and Relay startup accept trusted identity adapters; their default
  startup closures have no enterprise identity dependency. The downstream product owns private
  CLI/configuration compatibility, human qualification and presentation and
  explicitly selects standalone/managed bundled entries. Headless core continues
  to own local/OIDC login, membership, Actor authority and execution lifetime.
  The enterprise identity implementation, private catalogs and enterprise integration tests are now
  downstream-owned; the public workspace no longer depends on that package.
  Generic Actor/relay/storage tests remain public and use a synthetic signed
  identity source where needed. The product installs its own locked workspace
  against this exact checkout and validates private catalogs and lifecycle tests.
  The generic
  HTTP/WS gateway now consumes a trusted request-identity port, with no enterprise identity
  imports, private route names, expiration rules or employee mapping. Managed
  document admission uses the core endpoint; the enterprise identity plugin owns its legacy
  alias. The assertion verifier no longer hardcodes that private alias; trusted
  managed site startup declares it as an additional exact admission probe. Default core
  assertions only recognize the generic endpoint, with all original binding and
  replay checks retained. This removes one dependency edge, not the product entrypoint closures.
- Expo's default entry now composes the existing native Workbench/Composer and
  direct WebSocket Host without selecting the downstream product Router, account or Bot DOM.
  `OPENCRAFT_EXPO_PRODUCT_ENTRY` and `OPENCRAFT_EXPO_PRODUCT_CONFIG` are trusted
  local build inputs. Downstream `products/<product>/run-expo.cjs` selects the original
  Router or agents-next entry, owns edition configuration and the private iOS
  Bot prerequisite, and passes this choice through the entire native build.
  The shared runner generates only public math/Mermaid assets. Original private
  routes, account/region components, Bot views and their original tests now live
  in downstream `products/<product>/native`. The original Router registration consumes
  an explicitly selected product route context; core keeps the shared native
  Workbench and rendering adapters. Downstream styles scan the moved sources,
  and the product resolver binds shared SDK dependencies to the host instance.
  Platform/Hermes entities now live downstream too. Private native build aliases and agents-next assembly now belong downstream;
  generic APK/IPA commands no longer select a private product. the downstream product owns its
  original release naming and permission text, while core retains SDK/signing
  mechanics. Private smoke/tool aliases are now downstream-owned as described
  above. The fixed-revision source cutover is operational; source provenance
  review and public-release validation remain incomplete.
  Public native development identifiers remain legacy values in this phase;
  product release identifiers and callbacks are unchanged.
- The original Platform/Hermes plugins, account SDK and the product's agent-core,
  chat-client and collaboration Web snapshots live
  in downstream `products/<product>/plugins` and `products/<product>/packages`. Their package
  names and runtime implementations are preserved. Product tests own the original
  private cases; mixed suites keep generic Actor/Host/Workbench checks in core.
  Product SSR tests bind transitive dependencies to the core renderer's React
  instance, matching the production bundler's deduplication.
- Product shared-package and frontend-closure generators now live in downstream
  `products/<product>/tooling`. Private core CLI aliases and compatibility wrappers
  are removed; downstream commands explicitly select the original core working
  directory and toolchain. Core boundary checks reject product source paths in
  public tools and package commands. The Console generator
  writes original skill artwork to downstream `products/<product>/public`, which also
  owns the original cloud-service proxy Worker. `products/<product>/build-web.mjs` and explicit
  managed site builds select this trusted local directory using
  `OPENCRAFT_PRODUCT_PUBLIC_DIR`; public default builds do not carry it. Original
  URLs and bytes are preserved, and native Bot documents retain
  `copyPublicDir: false`. Private probes and build aliases are downstream-owned. Snapshot
  drift remains a real failing check, not a reason to edit generated copies or
  revert current styling. The private desktop provider's original prohibitions
  run in the product default test command after the provider moves downstream.

The first boundary work must preserve credential-scope revocation, identity
expiry, participant metadata, browser/WS admission and runtime disposal. A
successful build with those behaviors disabled is not a completed split.

## Current delivery decision (2026-10-19)

Reader-facing text and owned core names use OpenCraft identity. Extra source
comments and source archives are removed without rewriting working implementations.
Actual provider integrations retain their protocol names. Persisted identifiers
need explicit compatibility handling when renamed; copy editing cannot silently
change saved selections or external contracts.

Original core contributions use Apache-2.0. Third-party copyright, license and
required notices remain. Removing extra records does not establish redistribution
rights, claim independent authorship or authorize publication. Do not resume
implementation replacement work solely for a naming or archive cleanup.

The canonical GitHub repository owns contributions, protected checks and release
automation. The old history archive stays private. Complete Web/Electron/Expo
clients remain in core; the downstream product/enterprise identity/managed site composition remains downstream. Dependency
findings stay advisory across the visibility change, with full reports retained.
Secrets scans, relevant builds/tests and protected normal PR merges remain.
No npm publication or downstream deployment is authorized by this cutover step.

## Downstream import

During the transition, a source-tree import avoids the known external
committer ancestry rejection without rewriting contributors. The downstream import tool
`scripts/opencraft-upstream.py` reads a separately fetched upstream clone:

```sh
python3 scripts/opencraft-upstream.py plan --source /absolute/upstream \
  --revision FULL_UPSTREAM_COMMIT
```

Review its immutable source tree and destination head. In a fresh isolated
feature branch, `import` with `--expected-head` and `--expected-tree` writes
the reviewed source plus any recorded downstream patches under `opencraft/`,
with one local parent and a receipt at
`docs/upstream/opencraft.json`. It transfers source blobs, not foreign commits;
the receipt and commit trailers retain the GitHub source SHA, tree and URL.
The tool refuses dirty worktrees, ignored files in the replaced prefix, stale
plans and direct imports onto the default or protected branches. It does not fetch, push or
deploy. After the first pin, it verifies that the old pin plus the registered
patch stack reconstructs the entire current subtree; unrecorded committed
edits and invalid receipts are rejected rather than overwritten.

The downstream-owned ordered patch manifest references reachable ordinary local
commits, with source and resolved trees recorded separately. A tested local fix
can be registered with `record-patch` while its upstream PR remains pending or
is declined. Product implementation belongs in downstream composition; a local
core patch is an adoption bridge, not a second long-lived product core. `plan`
replays the stack using three-way tree merges in a disposable repository.
Conflicts report the patch and paths and leave the destination unchanged.
Imports carrying patches require the reviewed `--expected-resolved-tree` too.
`verify` checks full reconstruction, not just changed files. After the pinned
upstream actually contains a fix, `retire-patch` permits removal only if the
remaining stack still reproduces the current source. A merged PR alone is not
evidence that the currently pinned version contains it. Automatic conflict adaptation is not implemented by this tool. Deployment
owners can invoke its fixed-commit reconstruction verifier before deciding
whether to build or skip an update; the tool itself does not deploy. Normal functional validation, downstream review, integration and
deployment remain separate operations; none may discard an unrecorded change.

The tool has completed the first actual accepted-main import and a subsequent
same-tree pin to the new canonical history. The downstream receipt retains
source SHA/tree/URL and the previous pin, while its separate history mapping
records the old private repository identity. No external committer ancestry is
required. Products are composed outside the replaced prefix. Validate each
subsequent import against the current upstream and downstream trees; an earlier
success cannot justify discarding a later unported core change.

## Release lifecycle

The main product packages and build entrypoints are isolated. Public development
tools and desktop product composition now have explicit boundary checks; remaining
consumer/build paths still require review. This is not a claim that every product
edge has been removed. When an npm release
is requested, merge a release PR
that raises `packaging/web-server/package.json` and includes the exact
`## vX.Y.Z` changelog section. The main workflow creates the immutable tag and
performs preflight, package-once, exact-byte npm publication and verification.
Existing-tag manual dispatch remains the retry path. The npm-release
environment stays restricted to main and uses OIDC; no long-lived token is
introduced. Source inventory integrity is checked; source cleanup is not a
publication prerequisite under the current owner decision.

The owner has authorized the GitHub public cutover. This does not claim an
npm/desktop release. npm publication is deferred by the current owner decision;
it is not a prerequisite for using the GitHub source upstream. Verify
actual GitHub settings, CI, registry bytes and a clean consumer before declaring
a public release complete.

Connector brand images were subsequently excluded from current core following
their exact-source review. Existing licensed category icons retain service
identification alongside unchanged service names, catalog and operations.
This exclusion does not establish redistribution rights for old Git history or
change downstream artwork.

Connector management is contributed through the generic View role and its eligible Settings Page. Public App no longer names a downstream management page; product composition must declare the existing destination. This does not migrate or replace connector execution/authentication.

### Explicit client presentation composition

The core no longer selects icon family, default color theme or Mist visibility by
a commercial product ID. Trusted Vite composition declares optional presentation
policy; public builds retain standard defaults. Identity/data scopes, stored theme
IDs, saved choices and fixed legacy artwork remain unchanged. Product and embedded
composition live downstream. This is an ownership cut, not a provenance clearance
or a product deployment.

Navigation stroke styling also follows the declared icon style on each
presentation root, including Shadow hosts. Product identity no longer selects
that CSS rule; the classic selected/outline SVG strokes remain intact.
Private login, management and onboarding styles belong to the downstream
product and must be supplied in both its full-page and ShadowRoot assemblies.
The core startup resource checker accepts additional required roots and
demand-only patterns from trusted Vite composition. Product module paths are
not built into core policy; additional policy cannot relax core byte, request
fanout or demand-only limits.
