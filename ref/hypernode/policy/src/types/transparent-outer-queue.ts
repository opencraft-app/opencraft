import type { AppServerConnection } from "./appserver.ts";
import type {
  TransparentPendingOuterAction,
} from "./transparent-backend.ts";

export interface TransparentOuterQueueRequest {
  connection: AppServerConnection;
  outerThreadId: string;
  action: TransparentPendingOuterAction;
}

export interface TransparentOuterQueuePort {
  enqueue(request: TransparentOuterQueueRequest): void;
}
