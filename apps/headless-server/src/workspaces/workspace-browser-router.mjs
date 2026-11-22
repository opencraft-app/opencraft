import { EventEmitter } from "node:events";

/**
 * Private transport under ONE RemoteBrowserService, never a second page store.
 * resolve(pageId) must consult authenticated durable page/conversation bindings.
 * It returns the same lease object for an incarnation, with synchronous
 * assertCurrent() and connect() using the private sandbox owner transport.
 * No sandbox identifier, socket path or credential comes from request input.
 * Connections are lifetime-bound: losing any peer retires this router. The
 * central service retains unknown capacity and reconciles on its next attach.
 */
export function createWorkspaceBrowserRouter({
  resolve,
  captureRoute = () => () => {},
  maxPending = 256,
  timeoutMs = 70000,
}) {
  if (
    typeof resolve !== "function" ||
    typeof captureRoute !== "function" ||
    !Number.isInteger(maxPending) ||
    maxPending < 1 ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs < 1
  )
    throw Error("Invalid browser router options");
  const router = Object.assign(new EventEmitter(), {
    connected: true,
    inventory: [],
    inventoryComplete: false,
    automationCancellation: 1,
    automationNavigation: 1,
  });
  const peers = new Map(),
    routes = new Map(),
    pending = new Map();
  const unavailable = () =>
    Object.assign(Error("Workspace browser unavailable"), {
      code: "BROWSER_UNAVAILABLE",
      retryable: false,
      outcome: "unknown",
    });
  const check = (lease) => {
    if (!router.connected) throw unavailable();
    lease.assertCurrent();
  };
  const retire = () => {
    if (!router.connected) return;
    router.connected = false;
    for (const job of pending.values()) clearTimeout(job.timer);
    pending.clear();
    routes.clear();
    for (const entry of peers.values()) entry.peer?.kill();
    router.emit("exit");
  };
  router.kill = retire;
  let closing;
  router.close = () =>
    (closing ??= (async () => {
      retire();
      const results = await Promise.allSettled(
        [...peers.values()].map(async (entry) => {
          await entry.ready.catch(() => {});
          await entry.peer?.close?.();
        }),
      );
      if (results.some((result) => result.status === "rejected")) throw Error("Workspace browser cleanup unconfirmed");
    })());
  const attach = (lease) => {
    let entry = peers.get(lease);
    if (entry) return entry.ready;
    if (peers.size >= 64) throw unavailable();
    entry = {};
    peers.set(lease, entry);
    entry.ready = (async () => {
      check(lease);
      const peer = await lease.connect();
      entry.peer = peer;
      try {
        check(lease);
        if (!peer.connected || peer.automationCancellation !== 1 || peer.automationNavigation !== 1)
          throw unavailable();
        peer.on("exit", retire);
        peer.on("error", retire);
        peer.on("message", (message) => {
          try {
            check(lease);
          } catch {
            retire();
            return;
          }
          if (!message || typeof message !== "object") return;
          if (message.type === "owner-failure") {
            retire();
            return;
          }
          if (message.type === "result") {
            const job = pending.get(message.id);
            if (!job || job.peer !== peer || job.lease !== lease) return;
            pending.delete(message.id);
            clearTimeout(job.timer);
            try {
              job.checkRoute();
            } catch {
              router.emit("message", {
                type: "result",
                id: message.id,
                error: {
                  message: "Browser route changed",
                  code: "BROWSER_UNAVAILABLE",
                  retryable: false,
                  outcome: "unknown",
                },
              });
              return;
            }
            router.emit("message", message);
          } else if (typeof message.page === "string" && routes.get(message.page) === lease) {
            try {
              captureRoute(message.page, lease)();
            } catch {
              return;
            }
            router.emit("message", message);
          }
        });
        return peer;
      } catch (error) {
        peer.kill();
        throw error;
      }
    })();
    return entry.ready;
  };
  router.send = (input, callback = () => {}) => {
    if (
      !router.connected ||
      !input ||
      typeof input.id !== "string" ||
      typeof input.page !== "string" ||
      !input.id ||
      !input.page ||
      pending.has(input.id) ||
      pending.size >= maxPending
    ) {
      callback(unavailable());
      return;
    }
    // Snapshot before asynchronous admission; no caller mutation can reroute it.
    let message;
    try {
      message = structuredClone(input);
    } catch {
      callback(unavailable());
      return;
    }
    if (message.method === "cancelAutomation") {
      const original = pending.get(message.input?.requestId);
      if (!original || original.page !== message.page) {
        callback();
        return;
      }
      original.cancelled = true;
      if (original.peer) {
        try {
          check(original.lease);
          original.peer.send(message, callback);
        } catch {
          retire();
          callback(unavailable());
        }
      } else callback();
      return;
    }
    const job = { page: message.page, cancelled: false };
    job.timer = setTimeout(retire, timeoutMs);
    job.timer.unref();
    pending.set(message.id, job);
    void (async () => {
      const lease = await resolve(message.page);
      check(lease);
      const prior = routes.get(message.page);
      if (prior && prior !== lease) throw unavailable();
      job.lease = lease;
      job.checkRoute = captureRoute(message.page, lease);
      if (typeof job.checkRoute !== "function") throw unavailable();
      const peer = await attach(lease);
      check(lease);
      job.checkRoute();
      if (job.cancelled || (routes.has(message.page) && routes.get(message.page) !== lease)) throw unavailable();
      if (!routes.has(message.page) && routes.size >= 1024) throw unavailable();
      routes.set(message.page, lease);
      job.peer = peer;
      peer.send(message, (error) => {
        if (error) retire();
        callback(error);
      });
    })().catch((error) => {
      if (
        !job.peer &&
        error?.code === "BROWSER_ROUTE_STALE" &&
        error.outcome === "not-dispatched" &&
        pending.get(message.id) === job
      ) {
        // This request has not reached a peer. Reject its stale preparation,
        // not a different page's accepted close or the whole shared owner.
        pending.delete(message.id);
        clearTimeout(job.timer);
        router.emit("message", {
          type: "result",
          id: message.id,
          error: {
            code: "BROWSER_ROUTE_CHANGED",
            message: "Browser route changed before dispatch",
            retryable: false,
            outcome: "not-dispatched",
          },
        });
        callback();
        return;
      }
      // No replay or local fallback for uncertain dispatch/attachment loss.
      retire();
      callback(unavailable());
    });
  };
  return router;
}
