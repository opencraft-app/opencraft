import type { AppServerConnection } from "./appserver.ts";

export interface AdministratorPort {
  hasAgent(connection: AppServerConnection): boolean;
  unavailableGuidance(connection?: AppServerConnection): string;
}

export interface ThreadSearchOptions {
  limit?: number;
  excludeThreadId?: string | null;
  actorPrincipalId?: string | null;
}

export interface ThreadSearchResult {
  threadId: string;
  turnId: string | null;
  itemId: string | null;
  role: string;
  content: string;
  occurredAtMs: number;
  threadName: string;
  archived: boolean;
}

export interface ThreadSearchPort {
  readonly available: boolean;
  search(query: unknown, options?: ThreadSearchOptions): ThreadSearchResult[];
  render(input: unknown, options?: ThreadSearchOptions): string;
}
