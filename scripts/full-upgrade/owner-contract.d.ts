/** P2b boundary only. P3 supplies real implementations; unknown never means idle. */
export type Outcome = 'applied' | 'not-applied' | 'unknown' | 'draining' | 'conflict' | 'failed';
export interface OperationFence {
  operationId: string;
  stepId: string;
  action: string;
  epoch: number;
  fence: string;
}
export interface OwnerReceipt {
  outcome: Outcome;
  operationId: string;
  epoch: number;
  fence: string;
  identity?: string;
  bootId?: string;
  childJobId?: string;
  affectedCount?: number;
  healthy?: boolean;
  /** An opaque private evidence reference, never a command or payload. */
  evidenceId?: string;
}
export interface LeaseProof {
  ownerId: string;
  operationId: string;
  epoch: number;
  fence: string;
  bootId: string;
  incarnation: string;
  expiresAt: string;
  coverage: 'complete' | 'unknown';
  /** Includes pending creation/input, native turns, queue/goals/schedules,
   * approvals, callbacks, connections, tools, OS children and historical binds. */
  activeCount: number | null;
  historicalCount: number | null;
}
export interface ColdReadiness {
  identity: string;
  bootId: string;
  incarnation: string;
  manifestSha256: string;
  configurationSelectorSha256: string;
  storageOutcome: 'ready' | 'failed' | 'unknown';
  capabilitySha256: string;
  evidenceId: string;
}
export interface ConsistentBackup {
  /** Every inventory writer must appear; per-store online snapshots alone fail. */
  ownerIds: string[];
  storeIds: string[];
  unifiedWriteStopFence: string;
  manifestSha256: string;
  isolatedReadVerified: boolean;
  ledgerVerified: boolean;
  evidenceId: string;
  automaticSnapshotRestore: false;
}
export interface UpgradeOwner {
  /** Side-effect-free authority read. Applied receipts identify this exact op. */
  observe(operation: OperationFence): Promise<OwnerReceipt>;
  /** Must enforce epoch/fence CAS at the authority, never a read-then-stop gap. */
  apply(operation: OperationFence): Promise<OwnerReceipt>;
  acquireFence(operation: OperationFence): Promise<LeaseProof>;
  inspectDrain(operation: OperationFence): Promise<LeaseProof>;
  coldReady(operation: OperationFence): Promise<ColdReadiness>;
  releaseFence(operation: OperationFence, ready: ColdReadiness): Promise<OwnerReceipt>;
  backup(operation: OperationFence, allOwners: string[]): Promise<ConsistentBackup>;
}
