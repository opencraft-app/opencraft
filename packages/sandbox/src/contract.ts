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
  /** Connection-scoped lifetime for relay processes (non-terminal only). Loss of an
   * attached process's transport, or its unacknowledged termination, ends only that
   * process: `exited` rejects and `terminate()` rejects with SANDBOX_CLEANUP, but the
   * environment and its other processes stay alive; environment close still reclaims
   * it. Absent: a backend that cannot account for a lost process retires the whole
   * environment (fail closed). Host-side lifetime only; never sent to the guest. */
  readonly attached?: true;
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
/** Secret-free identity of one provider instance, persisted by its WorkspaceHost so a
 * restarted Host can re-attach (`SandboxBackend.attach`) instead of re-creating. */
export interface SandboxReceipt {
  /** The backend id that issued it; another backend never accepts it. */
  readonly backend: string;
  /** Provider instance identity (E2B sandbox id; a static provider's agent incarnation). */
  readonly instanceId: string;
}
export interface SandboxEnvironment {
  /** Present when the backend can re-attach to this exact instance after a Host restart. */
  readonly receipt?: SandboxReceipt;
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
  /** Optional: reconnect to the instance a receipt names, with the same effective
   * resources. Never creates or replaces an instance: when the provider cannot prove
   * it is the same instance (gone, restarted, different incarnation) it rejects with
   * SANDBOX_UNAVAILABLE and the owner decides whether to create a new one and recover. */
  attach?(identity: SandboxIdentity, receipt: SandboxReceipt, resources: SandboxResources, signal: AbortSignal): Promise<SandboxEnvironment>;
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
