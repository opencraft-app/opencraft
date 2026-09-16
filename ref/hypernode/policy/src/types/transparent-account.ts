import type { JsonRpcResponse } from "./appserver.ts";
import type { TransparentBackendState } from "./transparent-backend.ts";

export type TransparentAccountEventListener = (
  ownerUserId: string,
  message: JsonRpcResponse,
  state: TransparentBackendState,
) => void;

export interface TransparentAccountEventPort {
  on(listener: TransparentAccountEventListener): () => void;
  emit(
    ownerUserId: string,
    message: JsonRpcResponse,
    state: TransparentBackendState,
  ): void;
  handle(
    ownerUserId: string,
    message: JsonRpcResponse,
    emit: (message: JsonRpcResponse) => void,
  ): boolean;
}
