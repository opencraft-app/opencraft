# Minisandbox Miniflare API

This package provides the smallest useful subset of the Miniflare v3 API over a real Minisandbox
deployment. It uploads an immutable Worker version, validates its configured exports in workerd,
makes it the active Deployment, and lazily maps Durable Object names to persistent Actors backed by
Depot. Uploading content that is already the sole active version is a no-op at the Deployment layer.

```ts
import { Miniflare } from "@minisandbox/miniflare";

const mf = new Miniflare({
  endpoint: "https://workers.internal/v1",
  name: "counter",
  script: `
    import { DurableObject } from "cloudflare:workers";

    export class Counter extends DurableObject {
      async fetch() {
        const value = ((await this.ctx.storage.get("value")) ?? 0) + 1;
        await this.ctx.storage.put("value", value);
        return Response.json({ value });
      }
    }

    export default {
      fetch() { return new Response("ready"); }
    };
  `,
  durableObjects: { COUNTER: "Counter" },
  compatibilityDate: "2026-08-14",
});

const counters = await mf.getDurableObjectNamespace("COUNTER");
const alice = counters.getByName("alice");
const response = await alice.fetch("http://counter/increment");
console.log(await response.json());

await alice.delete();

await mf.dispose();
```

Implemented v3-shaped calls:

- `new Miniflare(options)` and `mf.ready`
- one public `endpoint`; Registry, Engine, namespace, runner, datacenter, Cell, and Actor IDs are private
- optimistic Deployment CAS, so concurrent publishers cannot silently replace each other
- `mf.dispatchFetch()`
- `mf.getWorker()` returning the stable public `Worker` resource
- `mf.getDurableObjectNamespace()`
- `namespace.idFromName()`, `idFromString()`, `newUniqueId()`, `get()`, and `getByName()`
- `stub.fetch()`, terminal `stub.delete()`, `mf.setOptions()`, and `mf.dispose()`

The current package is a Node-side control and request client, not an in-process workerd emulator.
`dispatchFetch()` uses one persistent default Actor. Worker-to-Durable-Object environment bindings,
alarms, WebSockets, queues, and scheduled events are outside this first subset. A module exporting a
Durable Object class must also provide a default export so the deployment can pass Worker prepare.
`mf.ready` resolves only after workerd compiles the inactive version and validates the default export
plus every configured Durable Object class; a rejected version never becomes active.

Worker Version identity covers source modules, compatibility settings, Durable Object bindings, and
exports. Changing only `durableObjects` therefore creates and validates a different immutable
Version instead of reusing the code-only digest.

Like upstream Miniflare v3, an accepted `setOptions()` call immediately invalidates namespaces and
stubs obtained before the call. This remains true if remote prepare or Deployment activation later
fails. The active remote Deployment is preserved on failure, but callers must retry `setOptions()`
and reacquire namespaces/stubs before issuing more requests. Options rejected synchronously during
local validation do not invalidate existing stubs.
