import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";
import type { DeviceCredential } from "../services/transparent-thread-routing.ts";

export type TransparentTurnExecutionDecision = "handled" | "queueCodex";

export interface TransparentTurnProvider {
  id?: string | null;
  providerId?: string | null;
  model?: string | null;
  displayName?: string | null;
  [key: string]: unknown;
}

export interface TransparentTurnRoute {
  kind?: string | null;
  engineKind?: string | null;
  provider?: TransparentTurnProvider | null;
  [key: string]: unknown;
}

export interface TransparentTurnCredential extends DeviceCredential {
  userId?: string | null;
  accountIdentity?: string | null;
  authMode?: string | null;
  credentialRef?: string | null;
}

export interface TransparentTurnExecutionRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
  threadId: string;
  /** The host already acknowledged a queue/add request; emit lifecycle only. */
  suppressResponse?: boolean;
}

export interface TransparentTurnExecutionPort {
  handle(request: TransparentTurnExecutionRequest): TransparentTurnExecutionDecision;
}
