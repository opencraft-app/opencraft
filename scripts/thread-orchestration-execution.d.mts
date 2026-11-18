import type { AgentDriverContract } from "../packages/appserver-client/src/agent-driver";
import type { AppHostServer } from "@opencraft/app-host-server";
export function createThreadOrchestrationExecution(
  getAppHost: () => AppHostServer | null | undefined,
  options?: {
    prepared?: (id: string) => Record<string, any> | null;
    enabled?: string[];
  },
): AgentDriverContract;
export function driverForThread(threadId: string): string;
