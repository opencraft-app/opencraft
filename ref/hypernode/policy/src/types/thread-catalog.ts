import type { AppServerConnection, AppServerParams } from "./appserver.ts";
import type { ThreadLifecycleThread } from "./thread-lifecycle.ts";

export interface ThreadCatalogStatus extends Record<string, unknown> {
  type: string;
}

export interface ThreadCatalogThread extends Record<string, unknown> {
  id: string;
  status: ThreadCatalogStatus;
}

export interface ThreadCatalogPage extends Record<string, unknown> {
  data: ThreadCatalogThread[];
}

export interface ThreadCatalogManagerPort {
  list(params?: AppServerParams, actorPrincipalId?: string | null): ThreadCatalogThread[];
  listPage(params?: AppServerParams, actorPrincipalId?: string | null): ThreadCatalogPage;
}

export interface ThreadCatalogProjectBindingPort {
  observeList(params: AppServerParams, connection: AppServerConnection): void;
}

export interface SystemThreadPort {
  get(): ThreadLifecycleThread;
  is(threadId: string): boolean;
}
