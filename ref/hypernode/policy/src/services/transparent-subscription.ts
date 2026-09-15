import { Service, type Context } from "@deepseek-ai/cordis";
import type { AppServerConnection } from "../types/appserver.ts";
import type { TransparentBackendState } from "../types/transparent-backend.ts";
import type { TransparentSubscriptionPort } from "../types/transparent-subscription.ts";

const CATALOG_DEDUPLICATION_WINDOW_MS = 2_000;
const CATALOG_DEDUPLICATION_SOFT_LIMIT = 256;

/**
 * Owns frontend subscription topology independently from backend processes.
 *
 * A frontend may remain subscribed while its execution Runtime is replaced;
 * conversely, a pooled Runtime may outlive every frontend subscription.
 */
export class TransparentSubscriptionService extends Service
  implements TransparentSubscriptionPort {
  readonly threadSubscribers = new Map<string, Set<AppServerConnection>>();
  private readonly catalogBroadcasts = new Map<string, number>();

  constructor(ctx: Context) {
    super(ctx, "transparentSubscription");
  }

  subscribe(connection: AppServerConnection, threadId: string): void {
    const subscribers = this.threadSubscribers.get(threadId) ?? new Set<AppServerConnection>();
    subscribers.add(connection);
    this.threadSubscribers.set(threadId, subscribers);
  }

  unsubscribe(connection: AppServerConnection, threadId: string): boolean {
    const subscribers = this.threadSubscribers.get(threadId);
    if (subscribers?.delete(connection) !== true) return false;
    if (subscribers.size === 0) this.threadSubscribers.delete(threadId);
    return true;
  }

  removeConnection(connection: AppServerConnection): string[] {
    const affected: string[] = [];
    for (const [threadId, subscribers] of this.threadSubscribers) {
      if (!subscribers.delete(connection)) continue;
      affected.push(threadId);
      if (subscribers.size === 0) this.threadSubscribers.delete(threadId);
    }
    return affected;
  }

  revokeWhere(
    threadId: string,
    shouldRevoke: (connection: AppServerConnection) => boolean,
  ): AppServerConnection[] {
    const subscribers = this.threadSubscribers.get(threadId);
    if (!subscribers) return [];
    const revoked: AppServerConnection[] = [];
    for (const connection of [...subscribers]) {
      if (!shouldRevoke(connection)) continue;
      subscribers.delete(connection);
      revoked.push(connection);
    }
    if (subscribers.size === 0) this.threadSubscribers.delete(threadId);
    return revoked;
  }

  hasSubscribers(threadId: string): boolean {
    return (this.threadSubscribers.get(threadId)?.size ?? 0) > 0;
  }

  targets(
    state: TransparentBackendState,
    threadId: string | null,
  ): readonly AppServerConnection[] {
    const subscribers = threadId === null ? undefined : this.threadSubscribers.get(threadId);
    return [...(subscribers?.size ? subscribers : state.connections)];
  }

  admitCatalogBroadcast(method: string, threadId: string, now = Date.now()): boolean {
    const key = `${method}\0${threadId}`;
    const previous = this.catalogBroadcasts.get(key) ?? 0;
    if (now - previous < CATALOG_DEDUPLICATION_WINDOW_MS) return false;
    this.catalogBroadcasts.set(key, now);
    if (this.catalogBroadcasts.size > CATALOG_DEDUPLICATION_SOFT_LIMIT) {
      for (const [candidate, timestamp] of this.catalogBroadcasts) {
        if (now - timestamp >= CATALOG_DEDUPLICATION_WINDOW_MS) {
          this.catalogBroadcasts.delete(candidate);
        }
      }
    }
    return true;
  }
}
