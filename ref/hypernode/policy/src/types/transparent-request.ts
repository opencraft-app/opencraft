import type {
  AppServerConnection,
  AppServerParams,
  JsonRpcRequest,
} from "./appserver.ts";

export type TransparentPassReason =
  | "outerCatalog"
  | "localCapability"
  | "notification"
  | "missingThreadId";

export type TransparentThreadOperation =
  | "history"
  | "settings"
  | "unsubscribe"
  | "archive"
  | "unarchive"
  | "fork"
  | "turnStart"
  | "turnSteer"
  | "turnInterrupt"
  | "queue"
  | "forward";

export type TransparentRequestRoute =
  | { kind: "poll" }
  | { kind: "pass"; reason: TransparentPassReason }
  | { kind: "backendServerResponse"; message: JsonRpcRequest }
  | { kind: "modelList"; message: JsonRpcRequest }
  | { kind: "userBackendControl"; message: JsonRpcRequest }
  | {
      kind: "threadStartCandidate";
      message: JsonRpcRequest;
      cwd: string | null;
    }
  | {
      kind: "thread";
      message: JsonRpcRequest;
      threadId: string;
      operation: TransparentThreadOperation;
    };

export interface TransparentRequestRouterPort {
  classify(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): TransparentRequestRoute;
}

export function requestParams(message: JsonRpcRequest): AppServerParams {
  return message.params ?? {};
}
