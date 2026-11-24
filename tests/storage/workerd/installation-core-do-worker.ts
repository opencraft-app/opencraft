// The production InstallationCore deployment assembly
// (apps/headless-server/src/cloudflare/worker.ts) with test-only controls, for
// tests/storage/installation-core-do-workerd.test.ts and the real-Cloudflare
// rehearsal. The subclass adds routes under `/__test/` and changes nothing
// else: every other request reaches the production object unchanged.
import entry, { InstallationCore } from "../../../apps/headless-server/src/cloudflare/worker.ts";
import type { DeploymentEnv } from "../../../apps/headless-server/src/cloudflare/bindings.ts";
import { fetchRequestView } from "@opencraft/http-exchange/fetch";

const REVOKED = "test/watch-revoked";

export class TestInstallationCore extends InstallationCore {
  #unwatch: (() => void) | null = null;
  override async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (!path.startsWith("/__test/")) return super.fetch(request);
    const storage = this.ctx.storage;
    switch (path) {
      // Drops the object's memory without any event, as platform eviction does.
      case "/__test/evict":
        this.ctx.abort("evicted for test");
        return Response.json(null);
      // Watches the caller's instance access as a long-lived connection would; revocation is recorded durably.
      case "/__test/watch": {
        const { instanceAccess } = this.services();
        const principal = instanceAccess.authenticate(fetchRequestView(request) as never);
        if (!principal) return Response.json({ error: "unauthenticated" }, { status: 401 });
        storage.kv.delete(REVOKED);
        this.#unwatch = instanceAccess.watch(principal, () => {
          storage.kv.put(REVOKED, Date.now());
          this.#unwatch?.();
          this.#unwatch = null;
        });
        return Response.json({ alarm: await storage.getAlarm() });
      }
      case "/__test/watch-state":
        return Response.json({
          revoked: storage.kv.get(REVOKED) ?? null,
          watching: this.#unwatch !== null,
          alarm: await storage.getAlarm(),
        });
      case "/__test/unwatch":
        this.#unwatch?.();
        this.#unwatch = null;
        return Response.json({ alarm: await storage.getAlarm() });
      case "/__test/close":
        await this.close();
        return Response.json(null);
    }
    return Response.json({ error: "missing" }, { status: 404 });
  }
}

export default {
  // This worker binds only the installation object; it never sends an account route to the entry.
  async fetch(request: Request, env: DeploymentEnv): Promise<Response> {
    if (new URL(request.url).pathname.startsWith("/__test/"))
      return env.INSTALLATION_CORE.get(env.INSTALLATION_CORE.idFromName("installation")).fetch(request);
    return entry.fetch(request, env);
  },
};
