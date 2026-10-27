import type { IntlShape } from "@opencraft/i18n";
import type { MachineResourceLifecycle } from "@opencraft/workbench-runtime";

/** Resource lifecycle copy stays independent from the Host connection dot. */
export function machineResourcePhaseLabel(
  resource: Pick<MachineResourceLifecycle, "phase" | "rawPhase"> | null,
  intl?: IntlShape,
): string | null {
  if (resource === null) return null;
  switch (resource.phase) {
    case "creating": return intl ? intl.formatMessage({ id: "machine.resource.creating", defaultMessage: "Creating resource" }) : "Creating resource";
    case "active": return intl ? intl.formatMessage({ id: "machine.resource.active", defaultMessage: "Resource active" }) : "Resource active";
    case "suspending": return intl ? intl.formatMessage({ id: "machine.resource.suspending", defaultMessage: "Suspending" }) : "Suspending";
    case "suspended": return intl ? intl.formatMessage({ id: "machine.resource.suspended", defaultMessage: "Suspended" }) : "Suspended";
    case "resuming": return intl ? intl.formatMessage({ id: "machine.resource.resuming", defaultMessage: "Resuming" }) : "Resuming";
    case "removing": return intl ? intl.formatMessage({ id: "machine.resource.removing", defaultMessage: "Removing resource" }) : "Removing resource";
    case "destroyed": return intl ? intl.formatMessage({ id: "machine.resource.destroyed", defaultMessage: "Resource removed" }) : "Resource removed";
    case "failed": return intl ? intl.formatMessage({ id: "machine.resource.failed", defaultMessage: "Resource failed" }) : "Resource failed";
    case "unknown": return resource.rawPhase || (intl ? intl.formatMessage({ id: "machine.resource.unknown", defaultMessage: "Unknown resource state" }) : "Unknown resource state");
  }
}
