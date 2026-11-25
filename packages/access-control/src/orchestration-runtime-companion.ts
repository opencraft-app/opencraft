// Runtime-neutral side of `Collaboration`'s orchestration runtime storage.
// The package export `@opencraft/access-control/orchestration-runtime-companion`
// resolves to this module everywhere except Node (the `node` condition), where
// orchestration-runtime-companion.node.ts can start a companion Worker on a
// Node file. Collaboration only asks for a companion when its storage has a
// Node file location, which no runtime without one ever lends.
import type { OrchestrationRuntimeClient } from "./orchestration-runtime-client.js";

const services = new WeakSet<object>();

/** Marks a runtime storage port that also serves communication commands. */
export function markOrchestrationRuntimeService(service: OrchestrationRuntimeClient): void {
  services.add(service);
}

/** Whether a composition's runtime storage is a full port (not only `updateExecution`). */
export function isOrchestrationRuntimeService(value: unknown): value is OrchestrationRuntimeClient {
  return typeof value === "object" && value !== null && services.has(value);
}

/** Without a Node file there is no companion Worker to start. */
export function openOrchestrationRuntimeCompanion(_location: string): OrchestrationRuntimeClient {
  throw new Error("File-backed orchestration storage requires the Node storage owner");
}
