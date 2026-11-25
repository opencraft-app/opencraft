import { allowsAppServerMethod, OPENCRAFT_METHOD_ACCESS_EXTENSION, parseAppServerMethodAccess } from "./method-access";

/** Host-owned PTYs, independent of Agent runs. attach/list are OpenCraft extensions. */
export const OPENCRAFT_TERMINAL_RESTORE_EXTENSION = "opencraft/terminal-restore";
/** Host/Hands terminal capability, independent of the selected engine. */
export const OPENCRAFT_TERMINAL_EXTENSION = "opencraft/terminal";

export function supportsTerminalDraftScope(extensions: Readonly<Record<string, unknown>> | null | undefined): boolean {
  const capability = extensions?.[OPENCRAFT_TERMINAL_EXTENSION];
  return typeof capability === "object" && capability !== null &&
    "version" in capability && capability.version === 1 &&
    "draftScopeOnThreadStart" in capability && capability.draftScopeOnThreadStart === true;
}

export function isTerminalResourceScopeId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
}
export const HOST_TERMINAL_METHODS = [
  "process/spawn", "process/attach", "process/list", "process/writeStdin", "process/resizePty", "process/kill",
] as const satisfies readonly (keyof AppServerProcessMethodMap)[];

export function isHostTerminalMethod(method: string): method is typeof HOST_TERMINAL_METHODS[number] {
  return (HOST_TERMINAL_METHODS as readonly string[]).includes(method);
}

/** Admission alone is not feature support. Legacy native servers lack attach/list. */
export function supportsTerminalMethod(
  extensions: Readonly<Record<string, unknown>> | null | undefined,
  method: keyof AppServerProcessMethodMap,
): boolean {
  if (!allowsAppServerMethod(extensions, method)) return false;
  if (method !== "process/attach" && method !== "process/list") return true;
  const capability = extensions?.[OPENCRAFT_TERMINAL_RESTORE_EXTENSION];
  const hands = extensions?.[OPENCRAFT_TERMINAL_EXTENSION];
  return (typeof capability === "object" && capability !== null
    && !Array.isArray(capability) && "version" in capability && capability.version === 1)
    || (typeof hands === "object" && hands !== null && !Array.isArray(hands)
      && "version" in hands && hands.version === 1
      && (("available" in hands && hands.available === true
        && "recovery" in hands && hands.recovery === true)
        // This advertises the routing protocol, not readiness of every target.
        // Each selected owner is authorized and probed before dispatch.
        || ("selection" in hands && hands.selection === "per-request")))
    || parseAppServerMethodAccess(extensions?.[OPENCRAFT_METHOD_ACCESS_EXTENSION])?.methods.includes(method) === true;
}

export interface ProcessOutput {
  processHandle: string;
  sequence: number;
  stream: "stdout" | "stderr";
  deltaBase64: string;
}
/** Resource identity is metadata; authenticated Host scope still authorizes access. */
export interface ProcessContext {
  resourceOwnerId: string | null;
  threadId: string | null;
  projectId: string | null;
  cwd: string;
  shell: string;
}
export const TERMINAL_RESOURCE_LIMITS = Object.freeze({
  activePerAccountHost: 16,
  activePerHost: 64,
  retainedPerHost: 64,
  outputBase64Bytes: 1024 * 1024,
  inputBase64Bytes: 1024 * 1024,
});
export interface ProcessSnapshot {
  context?: ProcessContext;
  processHandle: string;
  phase: "running" | "exited";
  exitCode: number | null;
  output: ProcessOutput[];
  nextSequence: number;
  truncated: boolean;
}
export interface AppServerProcessMethodMap {
  "process/spawn": {
    params: { processHandle: string; command: string[]; tty: true; streamStdoutStderr: true; outputBytesCap: null; timeoutMs: null; resourceOwnerId?: string; threadId?: string | null; projectId?: string | null; cwd?: string | null; env?: Record<string, string | null>; size: { cols: number; rows: number } };
    result: { processHandle: string };
  };
  "process/writeStdin": { params: { processHandle: string; deltaBase64: string }; result: Record<string, never> };
  "process/resizePty": { params: { processHandle: string; size: { cols: number; rows: number } }; result: Record<string, never> };
  "process/kill": { params: { processHandle: string }; result: Record<string, never> };
  "process/attach": { params: { processHandle: string; afterSequence: number }; result: ProcessSnapshot };
  "process/list": { params: { threadId?: string | null; projectId?: string | null }; result: { processes: Array<Omit<ProcessSnapshot, "output">> } };
}
