import { parseRuntimeMachineIdentity, type RuntimeMachineIdentity } from "./machine";

export const PERSONAL_MACHINES_METHOD = "opencraft/personal-machines";
export const MACHINE_SELF_UPDATE_METHOD = "opencraft/machine-runtime/update";

export interface PersonalMachine {
  readonly id: string;
  readonly name: string;
  readonly machine: RuntimeMachineIdentity | null;
  readonly connected: boolean;
  readonly phase: "pending" | "enrolled";
  readonly expiresAt: number | null;
  readonly version?: string | null;
  readonly updateAvailable?: boolean | null;
  readonly updateCommand?: string | null;
  readonly updating?: boolean;
  readonly updateError?: string | null;
}

export interface PersonalMachinesDirectory {
  readonly hubId: string;
  readonly ownerActorId: string;
  readonly enrollmentOrigin: string | null;
  readonly digest?: string;
  readonly machines: readonly PersonalMachine[];
}

export type PersonalMachineCommand =
  | { readonly action: "list" }
  | { readonly action: "create" }
  | { readonly action: "revoke"; readonly id: string }
  | { readonly action: "update"; readonly id: string };

export interface PersonalMachinesMethodMap {
  "opencraft/personal-machines": {
    params: PersonalMachineCommand;
    result: PersonalMachinesDirectory & {
      readonly command?: string;
      readonly machineId?: string;
    };
  };
  "opencraft/machine-runtime/update": {
    params: Record<string, never>;
    result: { readonly started: boolean };
  };
}

export function parsePersonalMachinesDirectory(value: unknown): PersonalMachinesDirectory {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Invalid machine directory");
  }
  const input = value as Record<string, unknown>;
  if (
    typeof input.hubId !== "string"
    || !input.hubId.trim()
    || typeof input.ownerActorId !== "string"
    || !input.ownerActorId.trim()
    || (input.enrollmentOrigin !== null && typeof input.enrollmentOrigin !== "string")
    || (input.digest !== undefined && typeof input.digest !== "string")
    || !Array.isArray(input.machines)
  ) {
    throw new TypeError("Invalid machine directory");
  }
  const machines: PersonalMachine[] = input.machines.map((raw) => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw new TypeError("Invalid machine entry");
    }
    const entry = raw as Record<string, unknown>;
    if (
      typeof entry.id !== "string"
      || !/^[0-9a-f-]{36}$/iu.test(entry.id)
      || typeof entry.name !== "string"
      || typeof entry.connected !== "boolean"
      || (entry.phase !== "pending" && entry.phase !== "enrolled")
      || (entry.expiresAt !== null && (typeof entry.expiresAt !== "number" || !Number.isFinite(entry.expiresAt)))
      || (entry.version !== undefined && entry.version !== null && typeof entry.version !== "string")
      || (entry.updateAvailable !== undefined && entry.updateAvailable !== null && typeof entry.updateAvailable !== "boolean")
      || (entry.updateCommand !== undefined && entry.updateCommand !== null && typeof entry.updateCommand !== "string")
      || (entry.updating !== undefined && typeof entry.updating !== "boolean")
      || (entry.updateError !== undefined && entry.updateError !== null && typeof entry.updateError !== "string")
    ) {
      throw new TypeError("Invalid machine entry");
    }
    const machine = entry.machine === null ? null : parseRuntimeMachineIdentity(entry.machine);
    if (entry.phase === "enrolled" && machine === null) {
      throw new TypeError("Missing machine identity");
    }
    return Object.freeze({
      id: entry.id,
      name: entry.name,
      machine,
      connected: entry.connected,
      phase: entry.phase,
      expiresAt: entry.expiresAt,
      ...(entry.version !== undefined ? { version: entry.version } : {}),
      ...(entry.updateAvailable !== undefined ? { updateAvailable: entry.updateAvailable } : {}),
      ...(entry.updateCommand !== undefined ? { updateCommand: entry.updateCommand } : {}),
      ...(entry.updating !== undefined ? { updating: entry.updating } : {}),
      ...(entry.updateError !== undefined ? { updateError: entry.updateError } : {}),
    });
  });
  return Object.freeze({
    hubId: input.hubId,
    ownerActorId: input.ownerActorId,
    enrollmentOrigin: input.enrollmentOrigin,
    ...(input.digest !== undefined ? { digest: input.digest } : {}),
    machines: Object.freeze(machines),
  });
}
