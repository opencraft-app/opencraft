import type {
  AppServerMethod,
  AppServerMethodParams,
  AppServerMethodResult,
} from "@opencraft/appserver-protocol";

import type { AppServerWorkbenchPhase } from "../appserver-runtime";
import type { HostRuntimeLifecycle } from "../host-runtime-registry";

export type AgentRuntimePhase = "bootstrapping" | AppServerWorkbenchPhase;

export interface AgentRuntimeSnapshot {
  readonly hostId: string;
  readonly phase: AgentRuntimePhase;
  readonly error: Error | null;
}

/** The initialized AppServer protocol session owned by one Agent Runtime. */
export interface AgentRuntimeProtocolPort {
  request<TMethod extends AppServerMethod>(
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<AppServerMethodResult<TMethod>>;
}

export interface AgentRuntimeSession extends HostRuntimeLifecycle {
  readonly resources: {
    readonly protocol: AgentRuntimeProtocolPort;
  };
  getSnapshot(): {
    readonly hostId: string;
    readonly phase: AppServerWorkbenchPhase;
    readonly error: Error | null;
  };
  subscribe(listener: () => void): () => void;
}

export interface AgentRuntimeAccess {
  getSnapshot(hostId: string): AgentRuntimeSnapshot;
  subscribe(hostId: string, listener: () => void): () => void;
  ensureReady(hostId: string): Promise<AgentRuntimeSession>;
  request<TMethod extends AppServerMethod>(
    hostId: string,
    method: TMethod,
    params: AppServerMethodParams<TMethod>,
  ): Promise<AppServerMethodResult<TMethod>>;
}
