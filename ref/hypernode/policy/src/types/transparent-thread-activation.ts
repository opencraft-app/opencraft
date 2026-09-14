import type { AppServerConnection, JsonRpcRequest } from "./appserver.ts";

export type TransparentThreadActivationDecision = "ready" | "pass";

export interface TransparentThreadActivationRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  threadId: string;
}

export interface TransparentThreadActivationPort {
  activate(request: TransparentThreadActivationRequest): TransparentThreadActivationDecision;
}
