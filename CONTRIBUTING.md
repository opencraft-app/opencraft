# Contributing to OpenCraft

GitHub is the target upstream for OpenCraft core. Open an issue or pull request
against `main`; use a separate branch and keep changes focused. Product identity
providers, company services and branding belong in downstream composition.

Read [the upstream boundaries](docs/upstream-transition.md) before transferring code
from a downstream repository. Do not replace current downstream changes with an
older snapshot or edit two copies of the same core feature independently.

## Choose the right contribution

| Change | Where it belongs | Start here |
| --- | --- | --- |
| Shared behavior, Actor authorization, Hub dispatch, lifecycle or a reusable integration port | OpenCraft core, with a focused PR against `main` | [AGENTS.md](AGENTS.md), then the affected package and its tests |
| Commands, navigation, settings, themes or other supported client contributions | A client Extension using public API V1 | [Extension development](docs/extension-development.md) and the [runnable example](examples/extensions/README.md) |
| Company login, branding, private services or deployment defaults | Downstream trusted product composition | [Boundary and compatibility guide](docs/extension-development.md#choose-a-boundary) |
| Skills, MCP, hooks or execution-engine capabilities | The owning Host/AppServer plugin or adapter | [Execution-side versus client plugins](docs/architecture/extensions/architecture-and-lifecycle.md#3-先区分两种插件) |

A client Extension does not need a core PR merely to be installed. Propose a
small reusable port upstream when the existing contract cannot express a real
consumer need; keep the product implementation downstream. Do not import app
internals to extend the downloaded Extension API.

## Move a downstream capability upstream

Start from the actual product call path and identify who owns identity,
credentials, execution and disposal. Put the reusable contract in core; keep the
product adapter and its service policy with the downstream consumer. A generic
port is useful only when that consumer can preserve its behavior through it.

Review the complete consumer migration before removing an old core adapter.
The downstream build must select the replacement explicitly, and public builds
must work without the private workspace. Preserve durable identifiers, saved
preferences and compatibility readers unless a separate migration changes them.
An absent product builtin is unavailable in that product, not a failed download.

Keep source acceptance separate from downstream adoption. An upstream merge does
not update a consumer's fixed revision. Advance that revision, reconcile every
local patch against the accepted source, validate the product, then retire only
patches whose behavior is actually present. Retain the original commit and PR
links; do not maintain a second editable implementation or discard local work to
make an upgrade clean. Use existing focused checks and actual client evidence
for the affected boundary rather than inventing another migration harness.

## Develop and validate

Follow the [repository layout](docs/repository-layout.md) when adding files. Keep
task-specific plans and findings with their topic rather than at the root.

Read [AGENTS.md](AGENTS.md) for ownership and [the build matrix](docs/build-matrix.md)
for the target platform. Use the pinned Node version in `.nvmrc` and `npm ci` in
your own checkout. Run checks relevant to the changed contract; describe actual
commands, results and limitations in the pull request. Platform behavior changes
need evidence from the affected client, including cancellation and restoration
when those lifecycles change. Do not claim a full platform build from unit tests.

From a fresh clone, run `npm ci`, then `npm run dev:web` for the browser client.
Use the URL printed by Vite. Building the public client needs no private product
checkout or model key; execution needs a configured Host.

Choose checks for the change instead of running every platform for every PR:

| Change | Commands from the repository root |
| --- | --- |
| Public Extension example / install / lifecycle | `npm run test:extension-example`, `npm run test:extensions`, `npm run test:extension-storage` |
| A workspace implementation | `npm run typecheck --workspace <package-name>` and its focused tests |
| Cross-package contract or dependency boundary | Both consumers' typechecks/tests and `npm run check:boundaries` |
| Web presentation or build integration | `npm run typecheck --workspace @opencraft/workbench-web` and `npm run matrix:build -- web-browser`, plus the actual affected interaction |
| CI selection or aggregate gate | `node --test tests/tooling/ci-plan.test.mjs tests/tooling/ci-workflows.test.mjs` |

The [build matrix](docs/build-matrix.md) describes explicit Electron/Expo/native
validation. A browser build does not prove those platforms work. Extension CI
runs on Linux when its contract, runtime, example or guide changes; other platform
builds remain opt-in under the existing CI policy.

## Open a pull request

Explain the problem and resulting behavior, affected platforms, checks actually
run and any unverified path. For an API change, identify the public versus trusted
product boundary, compatibility with API V1 consumers, and activation, cancellation,
replacement and disposal behavior. Include a regression for changed semantics;
keep a working older consumer when testing backward compatibility. V1 additions
must preserve existing behavior; incompatible changes need a new API version and
an explicit migration proposal. Current host compatibility is API **1**, not a
version-range resolver.

Original contributions use Apache-2.0. Preserve third-party notices and record
source provenance for imported/adapted material in the owning integration's
source records and license notices. Describe imported material, its license and
any notice changes in the pull request; repository publication does not establish
redistribution rights. Follow [SECURITY.md](SECURITY.md) for the actual repository
checks. Do not include credentials, account data, local logs or private worktree
paths in commits or reports.

For releases, use the repository's
[release skill](.agents/skills/opencraft-release/SKILL.md) and exact-artifact
workflow. A contribution PR does not deploy anyone's running instance.

### UI operations

Use the existing operation owner and shared notices. Show progress immediately,
report success only after the operation acknowledges, and preserve drafts on
failure. `SettingsButton loading={pending}` supplies visible progress and prevents
duplicate clicks; provide translated progress text when useful. Keep directory
revalidation independent from a confirmed write. A menu handing off to a modal
must not retain another modal interaction lock. Validate delayed/rejected actions
and the next real click after dialog exit; lint cannot establish those runtime
properties, and suppressing a promise rejection is not error feedback.
