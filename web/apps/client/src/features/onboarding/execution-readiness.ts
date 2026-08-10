import type {Agent, Computer} from "@vela/client-core";

export type ExecutionReadiness =
  | {agentId: string; stage: "ready"}
  | {stage: "connect_computer"}
  | {computerId: string; stage: "wait_computer_online"}
  | {computerId: string; stage: "create_agent"}
  | {agentId: string; stage: "start_agent"}
  | {stage: "ask_administrator"};

export function executionReadiness(input: {
  agents: Agent[];
  canManage: boolean;
  computers: Computer[];
}): ExecutionReadiness {
  const runningAgent = input.agents.find(
    (agent) => agent.observedState === "running",
  );
  if (runningAgent) return {agentId: runningAgent.id, stage: "ready"};

  if (!input.canManage) return {stage: "ask_administrator"};

  const onlineComputer = input.computers.find(
    (computer) =>
      computer.lifecycleState === "active" &&
      computer.connectionState === "online",
  );
  if (!onlineComputer) {
    const existingComputer = input.computers.find(
      (computer) => computer.lifecycleState === "active",
    );
    return existingComputer
      ? {computerId: existingComputer.id, stage: "wait_computer_online"}
      : {stage: "connect_computer"};
  }

  const existingAgent = input.agents[0];
  return existingAgent
    ? {agentId: existingAgent.id, stage: "start_agent"}
    : {computerId: onlineComputer.id, stage: "create_agent"};
}
