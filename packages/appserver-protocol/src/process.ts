/** Host-owned PTYs, independent of Agent runs. attach/list are OpenCraft extensions. */
export interface ProcessOutput {
  processHandle: string;
  sequence: number;
  stream: "stdout" | "stderr";
  deltaBase64: string;
}
export interface ProcessSnapshot {
  processHandle: string;
  phase: "running" | "exited";
  exitCode: number | null;
  output: ProcessOutput[];
  nextSequence: number;
  truncated: boolean;
}
export interface AppServerProcessMethodMap {
  "process/spawn": {
    params: { processHandle: string; command: string[]; tty: true; streamStdoutStderr: true; outputBytesCap: null; timeoutMs: null; cwd?: string | null; env?: Record<string, string | null>; size: { cols: number; rows: number } };
    result: { processHandle: string };
  };
  "process/writeStdin": { params: { processHandle: string; deltaBase64: string }; result: Record<string, never> };
  "process/resizePty": { params: { processHandle: string; size: { cols: number; rows: number } }; result: Record<string, never> };
  "process/kill": { params: { processHandle: string }; result: Record<string, never> };
  "process/attach": { params: { processHandle: string; afterSequence: number }; result: ProcessSnapshot };
  "process/list": { params: Record<string, never>; result: { processes: Array<Omit<ProcessSnapshot, "output">> } };
}
