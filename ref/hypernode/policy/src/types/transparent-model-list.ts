import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";

export interface TransparentModelListRequest {
  connection: AppServerConnection;
  message: JsonRpcRequest;
}

export interface TransparentModelListPort {
  handle(request: TransparentModelListRequest): void;
}
