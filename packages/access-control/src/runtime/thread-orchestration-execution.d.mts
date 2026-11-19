import type { AgentDriverContract } from "@opencraft/appserver-client";
import type { AppHostServer } from "@opencraft/app-host-server";
export function createThreadOrchestrationExecution(
  getAppHost: () => AppHostServer | null | undefined,
  options?: {
    prepared?: (id: string) => Record<string, any> | null;
    enabled?: string[];
  },
): AgentDriverContract;
export function driverForThread(threadId: string): string;
