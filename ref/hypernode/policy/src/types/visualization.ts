import type { AppServerConnection } from "./appserver.ts";

export interface VisualizationInvocation {
  connection?: Pick<AppServerConnection, "identity"> | null;
  threadId?: unknown;
  turnId?: unknown;
}

export interface VisualizationProjectionPort {
  helloWorld(invocation?: VisualizationInvocation): string;
}
