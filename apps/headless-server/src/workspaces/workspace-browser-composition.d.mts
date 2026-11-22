export interface WorkspaceBrowserDescriptor {
  ownerId: string;
  hostId: string;
  threadId: string | null;
  key: string;
  lifecycle: string;
  nativeGeneration: number | null;
}
export interface WorkspaceBrowserLease {
  assertCurrent(): void;
  connect(): Promise<unknown>;
}
/** Actual central RemoteBrowserService instance; it remains the only page store. */
export function installWorkspaceBrowserRouting(options: {
  service: unknown;
  resolveConversation(
    descriptor: WorkspaceBrowserDescriptor,
    local: WorkspaceBrowserLease,
  ): Promise<{ lease: WorkspaceBrowserLease; assertCurrent(): void }>;
}): void;
