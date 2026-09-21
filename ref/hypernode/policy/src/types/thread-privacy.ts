import type { AppServerConnection } from "./appserver.ts";

export interface ThreadPrivacyPort {
  listFor(
    connection: AppServerConnection,
    preferredThreadId?: string | null,
  ): Record<string, unknown>;
  makePrivate(
    threadId: string,
    connection: AppServerConnection,
  ): Record<string, unknown>;
  makeShared(
    threadId: string,
    connection: AppServerConnection,
  ): Record<string, unknown>;
}
