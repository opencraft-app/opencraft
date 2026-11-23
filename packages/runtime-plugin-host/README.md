# Runtime plugin host

Explicit operator-selected backend plugins for Node 26. This package is a loader,
not a sandbox, package registry, automatic discovery service or tenant isolation boundary.
The default application bootstrap never enables it; the Headless server loads it only
when trusted composition passes `runtimePlugins` (see below).

## Ownership and trust

- `store` validates manifests, file inventories, Node/API compatibility, paths and
  reserved routes. `installRuntimePlugin` copies verified bytes without importing
  code and defaults to disabled. The administrator-owned selection index pins the
  SHA-256 of the exact manifest, role configuration and enablement.
- `source` accepts a read-only byte provider and imports only from a private verified
  snapshot. The provider cannot select, install, enable or choose where code executes.
  Every fetch revalidates manifest and file digests; an unavailable source never
  silently activates a cached or locally installed fallback.
- `loadRuntimePlugins` owns activation, route registration, diagnostics and cleanup.
  Gateway callers must supply the existing authentication/admission authority.
  Protected application paths can be reserved by the composition. Plugins do not
  establish a second actor/session owner.
- `execution` is an explicit role; legacy `hands` is only an accepted manifest alias.
  This package does not launch workers or add any execution-environment bootstrap hook.
  Applications own process supervision, VFS adapters, private configuration and services.

Approved code executes with the current process privileges and can import Node or
other installed modules. Digests and owner/mode checks do not make that code safe;
an administrator must review it. A process with root write access can also rewrite
its selection store. Keep selection/cache directories outside user-writable exports.
Imported code must cooperate with lifecycle deadlines; timing out an import or a
Promise does not kill JavaScript. HTTP close drains accepted requests, so a plugin
that never settles may delay shutdown. Use an external supervisor for hard limits.

## Explicit composition

```js
import { installRuntimePlugin } from '@opencraft/runtime-plugin-host/store';
import { loadRuntimePlugins } from '@opencraft/runtime-plugin-host';

// Run only after administrator review, not in HTTP or plugin discovery.
await installRuntimePlugin('/approved/package', '/private/selections', { enable: true });
const host = await loadRuntimePlugins({
  directory: '/private/selections', role: 'gateway', authority: existingAuthority,
  protectedPaths: ['/__application_control'],
});
// Delegate only if host.handle(request, response) returns true.
// Shutdown: await host.close();
```

## Headless server composition

The public Headless server owns gateway loading when trusted startup code opts in.
There is no CLI flag; a selection index alone enables nothing.

```js
// Same composition object for startHeadlessServer(options, composition) or
// startContainerGateway(composition), which forwards it unchanged.
await startHeadlessServer(options, {
  createIdentity,               // optional; any instance admission owner works
  runtimePlugins: {
    directory: '/private/selections',        // default: runtimePluginDirectory(dataDirectory)
    packageSource: ({ dataDirectory }) => createVfsPluginSource({ ... }), // optional byte source
    cacheDirectory: '/private/plugin-cache', // default: <dataDirectory>/runtime-plugin-cache
    role: 'gateway',                          // default; 'execution' loads without routes
    protectedPaths: ['/__product_session'],   // product routes added to the core set
  },
});
```

- Plugins load after instance authentication/admission (`InstanceAccess`) and login
  sessions exist, and before the listener opens. Without instance admission a gateway
  load is skipped (`admission_unavailable`); routes are never served unauthorised.
- Declared routes are mounted inside the existing request pipeline after core admission
  and after every core handler, then the host re-checks `authenticate`/`admissionStatus`
  against the same owner. Every core `/__opencraft_*` namespace is protected in addition
  to the store's reserved set; `protectedPaths` adds product routes.
- A bad catalogue, source or plugin is skipped with a fixed reason code; the server starts.
  `/health` and `/__opencraft_health` report `plugins["opencraft.runtime-plugins"]` with
  selected IDs/versions and skipped reasons only.
- Shutdown closes plugins after the listener and ingress stop accepting and accepted
  plugin requests drain, before observability, identity, composition and stores close.
- A split static launcher forwards only core Headless routes; plugin routes require the
  Headless listener itself.

## Hands file source and container utility modes

`@opencraft/headless-server/host-filesystem-plugin-source` exports
`createHostFileSystemPluginSource({ root, endpoint, tokenFile })`: a `source` byte provider
that reads `root/packages/<id>/<revision>` through the Hands host-filesystem RPC
(`fs/readFile`). It enforces the per-file byte budget and canonical base64 before
`createVfsPluginSource` re-verifies digests; `close()` releases the RPC client. Pass it as
`runtimePlugins.packageSource` or to the executor below. It never discovers, installs,
enables or launches plugins on the file owner's side.

The container Gateway entry (`scripts/container-deployment/gateway.mjs`) has two explicit
utility modes that never start the Gateway or another owner. A distribution's own Gateway
entry composes the same modes with `runGatewayUtilityMode(process.argv.slice(2))` from
`scripts/container-deployment/runtime-plugin-tools.mjs`, starting its Gateway when it
returns `false`:

```sh
# Administrator check/install; prints the result as JSON.
container-gateway.mjs --runtime-plugin-admin check STORE
container-gateway.mjs --runtime-plugin-admin install PACKAGE STORE [--enable] [--gid=N] [--configuration-file=FILE]
# Long-running execution-role host, closed by SIGINT/SIGTERM.
container-gateway.mjs --runtime-plugin-executor ABSOLUTE_SELECTION_STORE
```

The executor activates only the `execution` role (legacy `hands` alias) and prints one
`runtime-plugin-executor-ready` line. Package bytes come from the selection store unless
all of `OPENCRAFT_RUNTIME_PLUGIN_VFS_DIRECTORY`, `OPENCRAFT_RUNTIME_PLUGIN_VFS_ENDPOINT` and
`OPENCRAFT_RUNTIME_PLUGIN_VFS_TOKEN_FILE` are set; then they are read through the Hands file
RPC into `OPENCRAFT_RUNTIME_PLUGIN_CACHE_DIRECTORY` (default `<store>/executor-cache`). A
partial configuration fails. The Hands environment bootstrap never calls either mode; the
platform supervises the executor process.

A manifest uses schemaVersion/hostApi 1, nodeMajor 26, a stable plugin ID,
sourceRevision, gateway/execution role entries and a bounded file inventory
(path, size, sha256). Refer to the synthetic fixtures for executable examples.
Configuration is frozen per activation. Diagnostics report fixed reason codes and
validated IDs, not raw plugin errors or private configuration. Unknown write results
must not be retried automatically.

Run regressions from the repository root:

```sh
node --import tsx --test tests/server/runtime-plugin-data.test.ts tests/server/runtime-plugin-source.test.ts \
  tests/server/runtime-plugin-host-filesystem-source.test.ts tests/server/runtime-plugin-executor.test.mjs
```
