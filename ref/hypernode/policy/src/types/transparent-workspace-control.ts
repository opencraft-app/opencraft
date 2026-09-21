import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";
import type { TransparentThreadOperation } from "./transparent-request.ts";

export type TransparentWorkspaceDecision = "handled" | "continue" | "pass";

export interface TransparentWorkspaceControlRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  threadId: string;
  operation: TransparentThreadOperation;
}

export interface TransparentWorkspaceRecord {
  state?: string;
  deleted?: boolean;
  [key: string]: unknown;
}

export interface TransparentWorkspaceControlPort {
  handle(request: TransparentWorkspaceControlRequest): TransparentWorkspaceDecision;
}
