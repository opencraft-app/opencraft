# Runtime plugin host

Explicit operator-selected backend plugins for Node 26. This package is a loader,
not a sandbox, package registry, automatic discovery service or tenant isolation boundary.
Nothing imports or enables it from the default application bootstrap.

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

A manifest uses schemaVersion/hostApi 1, nodeMajor 26, a stable plugin ID,
sourceRevision, gateway/execution role entries and a bounded file inventory
(path, size, sha256). Refer to the synthetic fixtures for executable examples.
Configuration is frozen per activation. Diagnostics report fixed reason codes and
validated IDs, not raw plugin errors or private configuration. Unknown write results
must not be retried automatically.

Run regressions from the repository root:

```sh
node --test tests/server/runtime-plugin-data.test.ts tests/server/runtime-plugin-source.test.ts
```
