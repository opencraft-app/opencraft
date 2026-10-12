import type { MessageSender } from "@opencraft/appserver-protocol";

/** Host-owned history access for optional product metadata. Never model input. */
export interface ThreadMetadataContext {
  getSender(threadId: string, messageId: string): MessageSender | null;
  hasSenders(threadId: string): boolean;
  readMessageIds(threadId: string, turnId?: string): Promise<readonly string[]>;
  notify(method: string, params: Record<string, unknown>): void;
}

export interface ThreadMetadataExtension {
  readonly methods: readonly string[];
  readonly capabilities: Readonly<Record<string, unknown>>;
  supports(method: string): boolean;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  observeResult(method: string, params: Record<string, unknown>, result: unknown): void;
  observeNotification(message: Record<string, unknown>): void;
  close(): void;
}
