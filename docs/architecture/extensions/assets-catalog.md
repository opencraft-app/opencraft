# Assets catalog UI and provider composition

The shared catalog presents environments, connections and verified libraries using
one page/draft owner. It is a trusted Web/Electron extension, not a credential
store, identity provider, execution allocator or authorization authority.

## Current delivery boundary

The @opencraft/plugin-assets package exports createAssetsExtension(options) and
the /view, /entry, /catalog, /contract and /details building blocks. A composition
can use the standard opencraft.assets view/navigation IDs or reuse the view under
existing IDs. Do not register both entrances for the same installation.

The extension is **not automatically enabled by the default Web/Electron
assembly**. A deployment must first supply its verified account owner and an
implemented, independently authorized configuration service. Shipping a menu
without those services does not enable asset management. The public default
service/desktop wiring remains separate work; this change does not claim that an
unmodified desktop release already contains a functional Assets entrance.

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
