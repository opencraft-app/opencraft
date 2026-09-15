import type { HostConnectionProfile } from "../host-connections";

export const ENVIRONMENT_SOURCE_CHANNEL = "environmentSource";
export type EnvironmentSourcePhase = "signed-out" | "loading" | "ready" | "error";
/** Cloud lifecycle is not a transport connection state. */
export interface EnvironmentEntry {
  readonly id: string;
  readonly sourceId: string;
  readonly name: string;
  readonly location: string;
  readonly lifecycle: string;
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
