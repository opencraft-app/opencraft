import type { ConnectorHostSnapshot } from "@opencraft/connector-core";
import type { ConnectorSnapshot } from "./contract";
import type { ConnectorApproval } from "./approvals";

export interface HeadlessConnectorState extends ConnectorHostSnapshot {
  readonly connections: readonly ConnectorSnapshot[];
  readonly selections: readonly { threadId: string; connectorIds: readonly string[] }[];
  readonly approvals: readonly ConnectorApproval[];
}
export interface ConnectorManagementClient {
  readonly hostId: string;
  requestRaw<T = unknown>(method: string, params: unknown, options?: { signal?: AbortSignal }): Promise<T>;
  subscribeNotification(listener: (event: { method: string; params?: unknown }) => void): () => void;
}
/** Negotiated ownership is stable even when authentication or the network fails.
 * Failure must not fall back to a second browser execution owner.
 */
export interface HeadlessConnectorPort {
  hostIds(): readonly string[];
  owns(hostId: string): boolean;
  state(hostId: string): HeadlessConnectorState | null;
  subscribe(listener: () => void): () => void;
  client(hostId: string): ConnectorManagementClient;
  refresh(hostId: string): Promise<void>;
  command(hostId: string, method: string, params: unknown): Promise<void>;
  dispose(): void;
}
