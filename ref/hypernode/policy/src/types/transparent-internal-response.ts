import type { JsonRpcResponse } from "./appserver.ts";
import type {
  TransparentBackendState,
  TransparentInternalRequest,
} from "./transparent-backend.ts";
import type { TransparentHandoffHost } from "./transparent-handoff.ts";
import type { TransparentBackendOpenHost } from "./transparent-open.ts";

/** Effects required to converge a backend response that belongs to HyperNode. */
export interface TransparentInternalResponseHost {
  handoff: TransparentHandoffHost;
  open: TransparentBackendOpenHost;
}

export interface TransparentInternalResponsePort {
  handle(
    state: TransparentBackendState,
    message: JsonRpcResponse,
    request: TransparentInternalRequest,
    host: TransparentInternalResponseHost,
  ): boolean;
}
