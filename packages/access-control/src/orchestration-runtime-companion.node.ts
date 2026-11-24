// Node side of `@opencraft/access-control/orchestration-runtime-companion`
// (the `node` export condition): a file-backed `Collaboration` starts its
// companion orchestration Worker on the same Node file, as before.
import { OrchestrationRuntimeWorker } from "./orchestration-runtime-store.js";

export { isOrchestrationRuntimeService, markOrchestrationRuntimeService } from "./orchestration-runtime-companion.js";

/** A standalone orchestration Worker that borrows the migrated file at `location`. */
export function openOrchestrationRuntimeCompanion(location: string): OrchestrationRuntimeWorker {
  return new OrchestrationRuntimeWorker(location);
}
