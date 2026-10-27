/** Daemon-owned identity. Host/Thread identity remains independent. */
export interface RuntimeMachineIdentity {
  readonly machineId: string;
  readonly name: string;
  readonly platform: "macos" | "linux" | "windows";
}

export function parseRuntimeMachineIdentity(value: unknown): RuntimeMachineIdentity {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid machine identity");
  const entry = value as Record<string, unknown>;
  if (typeof entry.machineId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(entry.machineId)
    || typeof entry.name !== "string" || !entry.name.trim()
    || typeof entry.platform !== "string" || !["macos", "linux", "windows"].includes(entry.platform)) throw new TypeError("Invalid machine identity");
  return Object.freeze({ machineId: entry.machineId, name: entry.name.trim(), platform: entry.platform as RuntimeMachineIdentity["platform"] });
}

export interface RuntimeMachineReadResponse {
  readonly machine: RuntimeMachineIdentity;
  readonly agent: "OpenCraft" | "Codex";
}

export function parseRuntimeMachineReadResponse(value: unknown): RuntimeMachineReadResponse {
  if (typeof value !== "object" || value === null) throw new TypeError("Invalid machine response");
  const entry = value as Record<string, unknown>;
  if (entry.agent !== "OpenCraft" && entry.agent !== "Codex") throw new TypeError("Invalid daemon Agent");
  return { machine: parseRuntimeMachineIdentity(entry.machine), agent: entry.agent };
}
