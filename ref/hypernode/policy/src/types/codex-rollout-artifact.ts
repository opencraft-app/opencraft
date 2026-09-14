import type { TransparentHandoffArtifact } from "./transparent-handoff.ts";
import type { HostUserRecord } from "./host-policy.ts";

/** Durable Codex rollout capabilities used by typed protocol services. */
export interface CodexRolloutArtifactRecord {
  threadId: string;
  innerThreadId: string;
  path: string;
  generation?: number | undefined;
  accountIdentity?: string | null | undefined;
  ownerUserId?: string | null | undefined;
  epoch?: number | null | undefined;
}

export interface CodexRolloutArtifactStorePort {
  prepare(
    threadId: string,
    rolloutPath: string,
    epoch: number,
    innerThreadId: string,
    options: { reidentify: boolean; modelProvider: string },
  ): TransparentHandoffArtifact;
  current(threadId: string): CodexRolloutArtifactRecord | null;
  values(): CodexRolloutArtifactRecord[];
  ensureModelProvider(path: string, providerId: string): {
    providerChanged: boolean;
    sessionMetaCount: number;
    responseItemIdsStripped: number;
  };
  findLegacySource(user: HostUserRecord | null, innerThreadId: string): string | null;
  readSource(path: string): Uint8Array;
  runtimePath(path: string, realm: "workspace" | "localhost"): string;
  resumeHistory(path: string): unknown[] | null;
  discard(artifact: TransparentHandoffArtifact): void;
  commit(
    artifact: TransparentHandoffArtifact,
    accountIdentity: string | null,
    epoch: number,
    ownerUserId: string,
  ): CodexRolloutArtifactRecord;
}
