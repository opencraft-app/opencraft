# Assets catalog UI and provider composition

The shared catalog presents environments, connections and verified libraries using
one page/draft owner. It is a trusted Web/Electron extension, not a credential
store, identity provider, execution allocator or authorization authority.

## Current delivery boundary

The @opencraft/plugin-assets package exports createAssetsExtension(options) and
the /view, /entry, /catalog, /contract and /details building blocks. A composition
can use the standard opencraft.assets view/navigation IDs or reuse the view under
existing IDs. Do not register both entrances for the same installation.

The default public Web/Electron workbench discovers the implemented assets service
at `/__opencraft_assets/status` during extension activation. A supporting host has
one shared `opencraft.assets` navigation/view owner. Missing/unsupported services
advertise no menu; no provider configuration or cached account hint grants access.

Headless starts the configuration Worker when the existing Human authentication
and instance-membership owners are configured. The bundled local-account/OIDC
Human login and existing instance admission decide access. A product that already
owns assistant environment configuration opts out through its existing managed
composition flag, retaining its route, data partitions and UI adapter. Electron's
native account host owns its service; the daemon's borrowed account host does not
start a second configuration writer.

## Ownership

- AssetsAccount.getScope() returns an opaque, stable verified account partition,
  or null when unavailable. subscribe and refresh belong to the existing
  account owner. Scope changes remount account-local drafts and cancel old reads.
  A scope/header is a stale-response fence, **never an authorization grant**.
- The supplied fetcher and endpoint address the existing service. Reads use GET;
  mutations POST JSON with an expected revision. The service derives the
  principal from authentication, checks membership and platform-management rights,
  and rejects a mismatching x-opencraft-account-scope. It must reauthorize after
  asynchronous request parsing and before committing writes.
- The catalog only receives credential metadata, never saved API keys. The service
  owns encrypted storage, compare-and-swap, key generations, policy validation and
  secret cleanup. Importing this UI provides none of those server guarantees.
- Providers declare trusted display metadata and supported editor capabilities.
  E2B uses the catalog's existing connection/environment form. Code-service
  editors and account environment variables remain provider-owned through
  useConnections and VariablesEditor; an absent variable editor has no action.
  Provider names/host strings do not authorize access or instantiate an adapter.
- Registering a connection does not grant execution, start a sandbox, verify an
  endpoint, mount storage, or connect code accounts to cloud environments. Keep
  those operations with their existing resource/admission owners.
- Network main-loop code must not open SQLite or perform synchronous vault IO.
  Server integration must reuse a lifecycle-owned Worker/async port, not import a
  synchronous storage implementation into a route handler.

## Working continuity and compatibility

The existing full editor is shared, not replaced with a summary-only page. It
preserves revision-conflict handling, unknown mutation outcomes without automatic
replay, nested environment/connection drafts, navigation confirmation, key
rotation/publication confirmation, account retirement and focus restoration.

Account scope strings, endpoint URLs, view IDs and stored namespaces are supplied
by composition. Extracting a view does not migrate or rename stored accounts,
rewrite an existing database or create another writable credential owner.

## Verification

- npm run test:extensions: metadata-only catalog and both-platform contribution
  registration/removal. Registration does not read account data or call services.
- npm run smoke:assets: production shared view with a synthetic authenticated
  backend and non-enterprise account scopes. Tests creation, secret-free
  projections, draft/DOM continuity, canceled discard and account switching.
- npm run smoke:sidebar-row-geometry: production Sidebar creation/destination
  geometry, mouse/touch density, themes, negative control and keyboard activation.

Browser fixtures are not a production identity/service integration, an Electron
binary test or external E2B acceptance.

## Server configuration owner

`@opencraft/plugin-assets/server` now supplies `openAssetConfigurations(directory)`.
It opens the existing encrypted vault **inside** a lifecycle-owned FIFO Worker,
returns an async configuration port and requires an awaited `close()` to drain
accepted requests. It preserves the existing document names, revision tombstones,
key generations, installed-template policy and generation-pinned library records.
No database migration, account renaming or new generic writable storage is added.
The server/configurations, server/installed-policy and server/libraries exports
are the synchronous domain owners for trusted runtime/Worker use, not network-loop
entrypoints. Only the async `/server` and `/server/http` paths belong in routers.

`assetConfigurationsHttp(store, authority)` implements the configuration protocol
at `/__opencraft_assets/configurations` (or a trusted assembly-supplied path).
An authority adapter must derive the scope, origin, expiry and independent endpoint
and platform permissions from the existing verified Human/session and membership
owners. Its `current()` covers all those grants; `subscribe()` must notify on
any invalidation. **This is a required host integration, not a new auth system.**
The request-local shared admission is withdrawn on account/role/session changes or
response disconnect. The Worker checks admission and expiry before executing a
queued operation, and the HTTP owner rechecks before exposing the result. An
operation already admitted into synchronous domain execution can finish; revocation
does not roll back a committed transaction. Unknown outcomes are never replayed.

The router pins the verified origin/Host, enforces same-origin POST and JSON,
limits bodies to 16 KiB, fences stale scopes, and returns private/no-store metadata.
The Worker exposes configuration/Git metadata snapshots and mutations, never decrypted runtime credentials,
installation adoption, arbitrary document reads or library registration. Saving
an environment is still not execution admission or external-provider validation.

Bundled consumers must place `assets-configuration-worker.mjs` beside the importer;
`scripts/packaging/package-assets-runtime.mjs` owns that build. The packaging test
runs the bundled owner and sibling Worker from an isolated temporary directory.
The default host composition is implemented by
`@opencraft/plugin-local-account/assets-server`: it consumes the existing HumanAuth,
ActorStore, HumanAccounts and InstanceAccess owners, and is one composition of
`openIdentityAssets` (below). Account/password/session, Actor/binding and
membership/role changes withdraw request-local admission before queued writes. Repositories borrowing the same owner share change notifications;
these notifications grant nothing. This does not claim that legacy authentication
storage IO has itself been migrated off the network thread.

### Identity compositions: `openIdentityAssets`

`@opencraft/plugin-assets/server/identity-assets` exports
`openIdentityAssets({ resolveRequest, port, origin, actors, membership, access,
provider?, gitHosts?, gitProviders?, environment? })`, the one implementation of the
`/__opencraft_assets/*` settings routes (status, configurations, Git connections
and, with `environment`, personal ENV). Any trusted composition uses it, whether it
authenticates with HumanAuth or with its own provider:

- `resolveRequest(request)` returns the request's verified login principal
  (`{ provider, subject, expiresAt }`), optionally the Actor it expects, a
  `current()` check and a `subscribe()` for login changes, or `null`. A bearer
  credential never reaches these browser settings routes.
- Main turns the principal into core's Human proof with `openActorAdmission`
  (`@opencraft/access-control/actor-admission`, also exported as
  `@opencraft/headless-server/workspaces/actor-admission`). The route's
  request-local permit replaces the proof's request permit, so a closed response
  or a login change retires it.
- `port` is the vault Worker (`openAssetConfigurations(...).store` or a
  composition's own Worker port). Its settings methods take only that proof:
  `actorConfigurationsSnapshot/Update`, `actorGitSnapshot/Update` and, where the
  Worker issues execution ENV, `environmentList/Replace/Projects`. The Worker
  validates the proof, rechecks it against the committed Actor/member records at
  admission, at each owner's commit boundary and before answering, and derives
  the `actor:<actorId>` partition and the role there. Main's
  `allowCustomEndpoints`/`canManagePlatform` are advisory `false`; the Worker
  decides both from the committed role (`createHeadlessExecutionRecords().actors.role`,
  or by default a read-only reader over the data directory's Actor store).
- The status route reports the proof's scope and, when served, `environment: true`.

A composition that owns its vault Worker therefore keeps only its login adapter
(`resolveRequest`) and its Worker composition; it no longer reads core's member
tables, mints account fences or copies the HTTP facades. The older
`snapshot/update/gitSnapshot/gitUpdate` Worker methods with a Main-built
`AssetAdmission` remain for existing callers.

### Personal ENV

`/__opencraft_assets/environment` serves the existing `AccountEnvironmentHttp`
protocol for the signed-in person, pinned to the trusted origin. It exists only
where the vault Worker is the execution ENV owner (`environmentLaunch`), so a saved
value is what launches read: the Worker writes the canonical Actor partition, or
the partition the composition's `environmentAccounts` mapping selects for that
Actor. Project scopes are limited to remembered Projects. Secret values are
write-only in both directions; no Worker answer to Main carries one. The default
client installs `createAssetVariablesEditor` (`@opencraft/plugin-assets/environment`)
as the view's `VariablesEditor` when status advertises it: the shared
`EnvironmentVariablesEditor` with `assets.env.*` messages (English defaults), fenced
to the account scope.

The client-side ServerAssetsAccount is only a resource-scope projection, not a
second login provider or credential store. It fences late replies, clears on
verified account withdrawal, preserves drafts across transient network failures,
and releases subscriptions on extension retirement. Every data request is still
authenticated, scope-fenced and authorized on the server. Code-account editors are
not advertised until a real provider port is installed.

## Default-entry acceptance

- `npm run test:assets-default`: actual Headless router with local setup and
  HttpOnly login cookie, actual native account host/static origin, encrypted
  Worker writes, CAS, and account/password/membership/binding/Actor/role withdrawal.
- `npm run test:human-auth`: includes bundled Headless setup/save/restart/readback,
  using the packaged sibling Worker, alongside the existing login regressions.
- `npm run smoke:assets-default`: real default extension discovery and registered
  navigation/lazy renderer with a real native Human account and Worker backend,
  touch Web/light and desktop-platform/dark, secret-free save and reload.
  The harness supplies the normal view-selection port. It is not an Electron
  binary launch or a complete AppShell/agent-execution test.

Saving E2B configuration is not cloud provisioning, an execution grant, endpoint
verification or a resource-budget change. Runtime workspace and Git-provider
extraction remain independent follow-up work.

## Git connections

The default native/Headless account assembly advertises `gitHosts` through
`/__opencraft_assets/status`. Only a compiled, advertised GitHub adapter installs
its provider and editor; an older or unsupported server has no fake Git action.
`/__opencraft_assets/git-connections` shares the same Human/session/membership
admission, origin checks, request-local revocation and vault Worker as environment
configuration. There is no second vault writer, login, account database or schema.

The shared Git controller owns request lifetimes, per-operation error namespaces,
strict metadata parsing and monotone revisions. The GitHub form keeps a local
secret draft and pinned expected revision; a background read cannot overwrite an
edited draft. Loading current data requires explicit confirmation. Failed or
unknown mutations are never replayed. Account retirement aborts every in-flight
response so an older successful read cannot restore withdrawn metadata.

The compiled GitHub provider fixes the REST origin to `api.github.com`, rejects
redirects and verifies account ID/login and a verified email (or the exact ID-based
noreply address). It retains a signing generation only for the same account ID.
Signing registration reconciles by exact public key before creating one: a lost
POST response remains pending, and an explicit retry first checks the remote list.
Missing signing permission is a manual-registration state, not discarded account
configuration. Removing a binding only removes the local credential; remote keys
and tokens must be revoked at GitHub separately.

Official API contracts: [verified email addresses](https://docs.github.com/en/rest/users/emails)
and [SSH signing keys](https://docs.github.com/en/rest/users/ssh-signing-keys).
Provider-specific hosts, identity mappings, SSH access and unrelated tool-token
namespaces stay in their own adapters. An adapter can reuse the shared form and
controller without changing its existing route, vault partition or revisions.

Validation uses synthetic GitHub responses, including a loopback remote reached
from the real Worker. No managed user token is read and no real remote key is
created. `test:assets-default` covers actual Human login/HTTP/Worker writes and
in-flight authority withdrawal. `smoke:assets-default` exercises the registered
view, Git save, conflict, canceled reload, explicit reconciliation and local clear.
It is a presentation harness with the production page frame, not a full AppShell
or Electron-binary acceptance test.

Saving/verifying Git configuration is not an execution grant. The default native
Actor's agent-execution credential handoff and cloud-workspace binding still need
runtime/admission integration; the configuration UI does not claim those paths.


### Native execution is a separate owner port

The Headless compiled `assets-runtime-worker.mjs` adds only a private, sealed Git
handoff method to this same owner. It is not reachable through either metadata
HTTP route and does not return a PAT or private key. Only its synchronous grant
read may overtake a provider network wait; configuration mutation ordering and
close/drain semantics remain unchanged. Native admission and current membership
still belong to the existing execution/Actor/access owners. The in-process Pi
consumer and the remaining Host-integration boundary are documented in
[managed Git identity](../identity/git-identity.md#native-human--actor-execution-handoff).
