import type {
  AppServerConnection,
  JsonRpcRequest,
} from "./appserver.ts";

export interface TransparentRequestDispatchPort {
  handle(
    message: JsonRpcRequest | null,
    connection: AppServerConnection,
  ): boolean;
}
