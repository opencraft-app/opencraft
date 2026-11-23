import type { MessageSender } from "@opencraft/appserver-protocol";

/** Host-owned history access for optional product metadata. Never model input. */
export interface ThreadMetadataContext {
  getSender(threadId: string, messageId: string): MessageSender | null;
  hasSenders(threadId: string): boolean;
  /** Copied history retains its author without joining the new Thread. */
  isInheritedMessage?(threadId: string, messageId: string): boolean;
  /** Abort releases local RPC ownership and stops pagination; native reads may still finish remotely. */
  readMessageIds(threadId: string, turnId?: string, signal?: AbortSignal): Promise<readonly string[]>;
  notify(method: string, params: Record<string, unknown>): void;
  /**
   * The file of the Host database the factory receives. A provider that keeps
   * blocking storage off the network thread borrows it from its own Worker and
   * leaves the main-thread handle unused. Absent for a store without a file.
   */
  readonly databasePath?: string;
}

/**
 * Observation methods run on the Host's network thread and must not block:
 * a provider with durable writes posts them to its storage owner and announces
 * changes only after the commit. Synchronous providers remain valid.
 */
export interface ThreadMetadataExtension {
  readonly methods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  supports(method: string): boolean;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  observeResult(method: string, params: Record<string, unknown>, result: unknown, sender?: MessageSender | null): void;
  observeNotification(message: Record<string, unknown>): void;
  /** Server-owned catalog discovery can refresh derived metadata without mounted rows. */
  observeCatalog?(threadIds: readonly string[]): void;
  /** A Worker-backed provider resolves after its posted writes committed; the Host awaits it before closing storage. */
  close(): void | Promise<void>;
}
