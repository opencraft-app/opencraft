import type { AppServerConnection, JsonRpcRequest } from "./appserver.ts";

export type TransparentThreadQueueDecision = "handled" | "queueCodex";

export interface TransparentThreadQueueRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  threadId: string;
}

export interface TransparentThreadQueuePort {
  handle(request: TransparentThreadQueueRequest): TransparentThreadQueueDecision;
}
