import type { MachineResourceLifecycle } from "@opencraft/workbench-runtime";

/** Resource lifecycle copy stays independent from the Host connection dot. */
export function machineResourcePhaseLabel(
  resource: Pick<MachineResourceLifecycle, "phase" | "rawPhase"> | null,
): string | null {
  if (resource === null) return null;
  switch (resource.phase) {
    case "creating": return "Creating resource";
    case "active": return "Resource active";
    case "suspending": return "Suspending";
    case "suspended": return "Suspended";
    case "resuming": return "Resuming";
    case "removing": return "Removing resource";
    case "destroyed": return "Resource removed";
    case "failed": return "Resource failed";
    case "unknown": return resource.rawPhase || "Unknown resource state";
  }
}
