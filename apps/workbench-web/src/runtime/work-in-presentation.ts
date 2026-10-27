import { groupWorkInMachines, workInMachineName, type WorkInMachine } from "@opencraft/workbench-runtime";
import type { useIntl } from "@opencraft/i18n/react";
import { parseWebDeploymentConfig } from "./web-deployment-config";
// The inert website configuration precedes module execution and is immutable
// for this Application; it is never a physical-machine identity authority.
const machineDisplayNames = typeof document === "undefined" ? undefined : parseWebDeploymentConfig(
  document.getElementById("opencraft-deployment-config")?.textContent ?? null,
)?.machineDisplayNames;
export { groupWorkInMachines };
export function machineName(machine: WorkInMachine, platform: "web" | "electron", intl: ReturnType<typeof useIntl>) {
  return workInMachineName(machine, platform, {
    thisMac: intl.formatMessage({ id: "workIn.thisMac", defaultMessage: "This Mac" }),
    thisComputer: intl.formatMessage({ id: "workIn.thisComputer", defaultMessage: "This computer" }),
    unknown: intl.formatMessage({ id: "workIn.unknown", defaultMessage: "Unknown machine" }),
  }, platform === "web" ? machineDisplayNames : undefined);
}

export function machineRole(machine: WorkInMachine, platform: "web" | "electron"): "local" | "server" | "cloud" {
  if (machine.cloud) return "cloud";
  return platform === "electron" && machine.hosts.some(host => host.providerId === "opencraft.builtin-agents") ? "local" : "server";
}
