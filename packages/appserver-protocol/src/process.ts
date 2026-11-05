import { allowsAppServerMethod, OPENCRAFT_METHOD_ACCESS_EXTENSION, parseAppServerMethodAccess } from "./method-access";

/** Host-owned PTYs, independent of Agent runs. attach/list are OpenCraft extensions. */
export const OPENCRAFT_TERMINAL_RESTORE_EXTENSION = "opencraft/terminal-restore";

/** Admission alone is not feature support. Legacy native servers lack attach/list. */
export function supportsTerminalMethod(
  extensions: Readonly<Record<string, unknown>> | null | undefined,
  method: keyof AppServerProcessMethodMap,
): boolean {
  if (!allowsAppServerMethod(extensions, method)) return false;
  if (method !== "process/attach" && method !== "process/list") return true;
  const capability = extensions?.[OPENCRAFT_TERMINAL_RESTORE_EXTENSION];
  return (typeof capability === "object" && capability !== null
    && !Array.isArray(capability) && "version" in capability && capability.version === 1)
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
