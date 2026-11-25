import type { SandboxReceipt, WorkspacePlacementRecord } from "@opencraft/sandbox";

export interface WorkspaceDirectoryCheckpoint {
  readonly snapshot: string;
  readonly receipt: SandboxReceipt;
}

export function directoryCheckpoint(
  placement: WorkspacePlacementRecord | undefined,
): WorkspaceDirectoryCheckpoint | null {
  if (
    !placement?.receipt ||
    !placement.snapshot ||
    (placement.snapshot.expiresAt !== undefined && placement.snapshot.expiresAt <= Date.now())
  )
    return null;
  return { snapshot: placement.snapshot.id, receipt: placement.receipt };
}

export function matchesDirectoryCheckpoint(value: unknown, placement: WorkspacePlacementRecord | undefined) {
  const expected = directoryCheckpoint(placement);
  const checkpoint = value as Partial<WorkspaceDirectoryCheckpoint> | null;
  return (
    !!expected &&
    checkpoint?.snapshot === expected.snapshot &&
    checkpoint.receipt?.backend === expected.receipt.backend &&
    checkpoint.receipt.instanceId === expected.receipt.instanceId
  );
}
