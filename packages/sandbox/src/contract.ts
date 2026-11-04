export interface SandboxResources {
  /** Capacity/quota requested from the selected provider, not host CPU affinity. */
  readonly cpuMillis: number;
  readonly memoryBytes: number;
}
export const DEFAULT_SANDBOX_RESOURCES: Readonly<SandboxResources> = Object.freeze({ cpuMillis: 4000, memoryBytes: 8 * 1024 ** 3 });
export interface SandboxPoolPolicy {
  readonly id: string;
  /** Admission budget for this provider, not necessarily this machine's RAM. */
  readonly capacity: SandboxResources;
  readonly defaults?: Partial<SandboxResources>;
  readonly queueLimit?: number;
}
export interface SandboxIdentity {
  /** Correlation/idempotency identity; never an OS PID or vendor-specific ID. */
  readonly id: string;
  readonly owner: string;
  readonly backend: string;
}
export interface SandboxCommand {
  readonly command: readonly string[];
  /** Path in the sandbox's filesystem, not implicitly a path on the Host. */
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly terminal?: { readonly cols: number; readonly rows: number };
}
export interface SandboxOutput { readonly stream: "stdout" | "stderr"; readonly data: Uint8Array }
export interface SandboxExit { readonly code: number | null; readonly signal?: string }
interface Process {
  readonly id: string;
  readonly exited: Promise<SandboxExit>;
  writeStdin(data: Uint8Array): Promise<void>;
  terminate(): Promise<void>;
}
export type SandboxProcess = (Process & { readonly kind: "process"; closeStdin(): Promise<void> }) | (Process & {
  readonly kind: "terminal";
  resize(size: { cols: number; rows: number }): Promise<void>;
});
export interface SandboxEnvironment {
  /** Effective constraints reported by the backend; absent fields are unclaimed. */
  readonly resources: Readonly<SandboxResources>;
  readonly capabilities: { readonly terminal: boolean };
  readonly processLimits?: { readonly tasks: number; readonly fileDescriptorsPerProcess: number };
  spawn(command: SandboxCommand, onOutput?: (output: SandboxOutput) => void): Promise<SandboxProcess>;
  /** Idempotent; resolves only after the environment and its executions are gone. */
  close(): Promise<void>;
}
export interface Sandbox extends SandboxEnvironment { readonly identity: SandboxIdentity }
export interface SandboxBackend {
  readonly id: string;
  /** Prepare only provider/pool control state; do not provision user environments. */
  initialize(policy: SandboxPoolPolicy, signal: AbortSignal): Promise<void>;
  /** Resources must be applied before user code runs. Do not retry unknown creation. */
  create(identity: SandboxIdentity, resources: SandboxResources, signal: AbortSignal): Promise<SandboxEnvironment>;
  close(): Promise<void>;
}
export class SandboxFault extends Error {
  constructor(readonly code: "SANDBOX_UNAVAILABLE" | "SANDBOX_POLICY" | "SANDBOX_CAPACITY" | "SANDBOX_CLOSED" | "SANDBOX_START" | "SANDBOX_CLEANUP" | "SANDBOX_CREATION_UNCONFIRMED", message: string) {
    super(message); this.name = "SandboxFault";
  }
}
export class SandboxCreationFault extends SandboxFault {
  constructor(readonly outcome: "not-created" | "unknown", readonly identity?: SandboxIdentity) {
    super(outcome === "unknown" ? "SANDBOX_CREATION_UNCONFIRMED" : "SANDBOX_UNAVAILABLE",
      outcome === "unknown" ? "Sandbox creation outcome is unconfirmed; capacity retained" : "Sandbox creation was rejected before an environment was retained");
  }
}
