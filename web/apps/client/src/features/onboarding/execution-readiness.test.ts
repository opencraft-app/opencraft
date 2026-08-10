import type {Agent, Computer} from "@vela/client-core";

import {executionReadiness} from "./execution-readiness";

const computer = {
  id: "computer-1",
  lifecycleState: "active",
  connectionState: "online",
} as Computer;

const runningAgent = {
  id: "agent-1",
  observedState: "running",
} as Agent;

describe("executionReadiness", () => {
  it("is ready when the Server already has a running Agent", () => {
    expect(
      executionReadiness({
        agents: [runningAgent],
        canManage: false,
        computers: [],
      }),
    ).toEqual({agentId: "agent-1", stage: "ready"});
  });

  it("asks an administrator to connect a Computer before creating an Agent", () => {
    expect(
      executionReadiness({agents: [], canManage: true, computers: []}),
    ).toEqual({stage: "connect_computer"});

    expect(
      executionReadiness({
        agents: [],
        canManage: true,
        computers: [{...computer, connectionState: "offline"}],
      }),
    ).toEqual({computerId: "computer-1", stage: "wait_computer_online"});
  });

  it("asks an administrator to create an Agent once a Computer is online", () => {
    expect(
      executionReadiness({
        agents: [],
        canManage: true,
        computers: [computer],
      }),
    ).toEqual({computerId: "computer-1", stage: "create_agent"});
  });

  it("does not offer ordinary members an Agent action they cannot perform", () => {
    expect(
      executionReadiness({agents: [], canManage: false, computers: [computer]}),
    ).toEqual({stage: "ask_administrator"});
  });

  it("guides an administrator to the existing Agent when it is not running", () => {
    expect(
      executionReadiness({
        agents: [{...runningAgent, observedState: "stopped"}],
        canManage: true,
        computers: [computer],
      }),
    ).toEqual({agentId: "agent-1", stage: "start_agent"});
  });
});
