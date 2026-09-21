import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";
export type TransparentThreadAdmissionDecision = "handled" | "pass";

export interface TransparentThreadAdmissionRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
}

export interface TransparentThreadAdmissionPort {
  handle(request: TransparentThreadAdmissionRequest): TransparentThreadAdmissionDecision;
}
