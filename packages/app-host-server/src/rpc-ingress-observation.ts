import {AsyncLocalStorage} from "node:async_hooks";
import type {RequestTrace} from "@opencraft/appserver-protocol";
/** Server-local receive/dequeue boundaries, never accepted from a wire stamp. */
export interface RpcIngressObservation {
  readonly started: number;
  readonly wallAt: number;
  readonly trace?: RequestTrace;
  dequeued: number;
  accessMs: number;
}
export const rpcIngressObservation=new AsyncLocalStorage<RpcIngressObservation>();
