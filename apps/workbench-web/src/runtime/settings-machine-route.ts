import type { WorkInMachine } from "@opencraft/workbench-runtime";

export function machineSettingsSection(machine: WorkInMachine): string {
  return `machine-${encodeURIComponent(machine.id)}`;
}

/** Correct old Host bookmarks and an unknown Host whose reported identity arrived later. */
export function replacementMachineSettingsSection(section: string, machines: readonly WorkInMachine[]): string | null {
  if (section.startsWith("execution-")) {
    const machine = machines.find(machine => machine.hosts.some(host => `execution-${encodeURIComponent(host.hostId)}` === section));
    return machine ? machineSettingsSection(machine) : "machines";
  }
  if (section.startsWith("machine-")) {
    const machine = machines.find(machine => machine.hosts.some(host => `machine-${encodeURIComponent(`host:${host.hostId}`)}` === section));
    if (machine && machineSettingsSection(machine) !== section) return machineSettingsSection(machine);
  }
  return null;
}
