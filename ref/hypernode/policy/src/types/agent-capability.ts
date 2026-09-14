export interface AgentCapabilitySkillBinding {
  name: string;
  description: string;
  instructions: string;
}

export interface AgentCapabilityToolBinding {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface AgentCapabilityBinding {
  capabilityId: string;
  /** Several tools may share one materialized Skill. */
  skill?: AgentCapabilitySkillBinding;
  tool: AgentCapabilityToolBinding;
  clientTool?: {
    namespace: string;
    tool: string;
    timeoutMs?: number;
  };
}

export interface AgentCapabilityRequest {
  capabilityId: string;
  threadId: string;
  turnId: string;
  callId: string;
  principalId: string | null;
  connection: import("./appserver.ts").AppServerConnection;
  arguments: Record<string, unknown>;
}

export interface AgentCapabilityResult {
  text: string;
}

export interface AgentCapabilityEgressPort {
  bindingsForThread(
    threadId: string,
    connection?: import("./appserver.ts").AppServerConnection | null,
  ): AgentCapabilityBinding[];
  execute(
    request: AgentCapabilityRequest,
  ): AgentCapabilityResult | Promise<AgentCapabilityResult>;
  cancel(threadId: string, callId: string, reason?: string): boolean;
}
