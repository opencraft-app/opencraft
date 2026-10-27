import type { AppServerClient, AppServerRequestLifecycleEvent } from "@opencraft/appserver-client";

let instanceSequence = 0;
const pendingOwners = new Map<string, Set<number>>();
const tracedMethods = new Set(["initialize", "runtime/machine/read", "thread/read", "thread/resume"]);

/** Renderer adapter: log protocol metadata only, never params, results or error messages. */
export function installAppServerDiagnostics(client: Pick<AppServerClient, "connectionGeneration" | "subscribeRequestLifecycle">, role: "runtime" | "identity-probe",
  write: (event: string, metadata: Record<string, unknown>) => void = (event, metadata) => console.info(`[appserver-diagnostics] ${event}`, metadata),
): () => void {
  const instance = ++instanceSequence;
  const owned = new Set<string>();
  let failures = 0;
  let disposed = false;
  const release = (key: string) => {
    owned.delete(key);
    const owners = pendingOwners.get(key);
    owners?.delete(instance);
    if (owners?.size === 0) pendingOwners.delete(key);
  };
  const stop = client.subscribeRequestLifecycle((event: AppServerRequestLifecycleEvent) => {
    if (disposed || event.type === "queued") return;
    const key = JSON.stringify([event.hostId, event.id]);
    const metadata: Record<string, unknown> = {
      hostId: event.hostId, clientInstance: instance, role, requestId: event.id,
      connectionGeneration: client.connectionGeneration,
    };
    if (event.type === "late-response") {
      if (failures++ < 20) write("late-response", metadata);
      return;
    }
    metadata.method = event.method;
    if (event.type === "started") {
      const owners = pendingOwners.get(key) ?? new Set<number>();
      if (owners.size > 0 && !owners.has(instance) && failures++ < 20) {
        write("request-id-collision", { ...metadata, otherClientInstances: [...owners] });
      }
      owners.add(instance);
      pendingOwners.set(key, owners);
      owned.add(key);
      if (tracedMethods.has(event.method)) write("request-started", metadata);
      return;
    }
    release(key);
    metadata.durationMs = event.durationMs;
    if (event.type === "completed") {
      if (tracedMethods.has(event.method)) write("request-completed", metadata);
    } else if (failures++ < 20) {
      const code = (event.error as { code?: unknown }).code;
      if (typeof code === "number" || (typeof code === "string" && /^[A-Z_]{1,64}$/.test(code))) metadata.errorCode = code;
      write(event.type, metadata);
    }
  });
  return () => {
    disposed = true;
    stop();
    for (const key of owned) release(key);
  };
}
