import type { AppServerConnection } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export interface TransparentSubscriptionPort {
  readonly threadSubscribers: ReadonlyMap<string, ReadonlySet<AppServerConnection>>;
  subscribe(connection: AppServerConnection, threadId: string): void;
  unsubscribe(connection: AppServerConnection, threadId: string): boolean;
  removeConnection(connection: AppServerConnection): string[];
  revokeWhere(
    threadId: string,
    shouldRevoke: (connection: AppServerConnection) => boolean,
  ): AppServerConnection[];
  hasSubscribers(threadId: string): boolean;
  targets(
    state: TransparentBackendState,
    threadId: string | null,
  ): readonly AppServerConnection[];
  admitCatalogBroadcast(method: string, threadId: string, now?: number): boolean;
}
