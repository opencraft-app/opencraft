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
}

export interface ThreadMetadataExtension {
  readonly methods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  supports(method: string): boolean;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  observeResult(method: string, params: Record<string, unknown>, result: unknown, sender?: MessageSender | null): void;
  observeNotification(message: Record<string, unknown>): void;
  /** Server-owned catalog discovery can refresh derived metadata without mounted rows. */
  observeCatalog?(threadIds: readonly string[]): void;
  close(): void;
}
