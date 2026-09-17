import type { HostConnectionProfile } from "../host-connections";

export const ENVIRONMENT_SOURCE_CHANNEL = "environmentSource";
export type EnvironmentSourcePhase = "signed-out" | "loading" | "ready" | "error";

export type MachineResourcePhase =
  | "creating"
  | "active"
  | "suspending"
  | "suspended"
  | "resuming"
  | "removing"
  | "destroyed"
  | "failed"
  | "unknown";

export function normalizeMachineResourcePhase(value: string): {
  readonly phase: MachineResourcePhase;
  readonly rawPhase: string;
} {
  const rawPhase = value.trim().toLowerCase();
  const phase: MachineResourcePhase = ["creating", "pending", "starting", "provisioning"].includes(rawPhase)
    ? "creating"
    : ["running", "ready", "active"].includes(rawPhase)
      ? "active"
      : ["stopping", "suspending"].includes(rawPhase)
        ? "suspending"
        : ["stopped", "suspended", "paused"].includes(rawPhase)
          ? "suspended"
          : ["restarting", "resuming"].includes(rawPhase)
            ? "resuming"
            : ["deleting", "terminating", "removing"].includes(rawPhase)
              ? "removing"
              : ["deleted", "destroyed", "terminated"].includes(rawPhase)
                ? "destroyed"
                : ["failed", "error"].includes(rawPhase)
                  ? "failed"
                  : "unknown";
  return Object.freeze({ phase, rawPhase });
}

export interface MachineResourceLifecycle {
  /** Provider that owns the resource. Null resource means unmanaged Host. */
  readonly providerId: string;
  readonly phase: MachineResourcePhase;
  /** Normalized provider value retained for diagnostics and forward compatibility. */
  readonly rawPhase: string;
  readonly message: string | null;
  readonly capabilities: {
    readonly suspend: boolean;
    readonly resume: boolean;
    readonly remove: boolean;
  };
}

export type MachineResourceAction = "suspend" | "resume" | "remove";

export interface MachineResourceActionRequest {
  readonly environmentId: string;
  readonly action: MachineResourceAction;
  /** Stable caller-owned identity. Providers must reconcile retries, not duplicate work. */
  readonly operationId: string;
}

export interface MachineResourceActionReceipt {
  readonly accepted: true;
  readonly environmentId: string;
  readonly action: MachineResourceAction;
  readonly operationId: string;
}
/** Cloud lifecycle is not a transport connection state. */
export interface EnvironmentEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly location: string;
  readonly resource: MachineResourceLifecycle | null;
  readonly connectable: boolean;
  /** A lazy connection recipe, never a resident runtime or a credential. */
  readonly profile: HostConnectionProfile;
}
export interface EnvironmentSourceSnapshot {
  readonly revision: number;
  readonly phase: EnvironmentSourcePhase;
  readonly entries: readonly EnvironmentEntry[];
  readonly error: string | null;
}
export interface EnvironmentSource {
  readonly id: string;
  readonly label: string;
  /** Claimed providers are not resurrected from stale saved profiles. */
  readonly providerIds: readonly string[];
  getSnapshot(): EnvironmentSourceSnapshot;
  subscribe(listener: () => void): () => void;
  refresh(): Promise<void>;
  /** Optional provider-owned resource mutation port. Absence means read-only lifecycle. */
  performResourceAction?(
    request: MachineResourceActionRequest,
  ): Promise<MachineResourceActionReceipt>;
  /** Optional migration/alias mapping, verified against the current authority. */
  matchProfile(profile: HostConnectionProfile): string | null;
}
export interface EnvironmentDirectorySnapshot {
  readonly revision: number;
  readonly entries: readonly EnvironmentEntry[];
  readonly sources: readonly {
    id: string; label: string; phase: EnvironmentSourcePhase; error: string | null;
  }[];
}

/** Length-delimited identity avoids separators and cross-account collisions. */
export function environmentIdentity(source: string, ...parts: string[]): string {
  return [source, ...parts].map(part => `${part.length}:${part}`).join("|");
}
