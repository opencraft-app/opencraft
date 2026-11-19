import type { AppHostServer } from "@opencraft/app-host-server";
import type { ConversationExecutionPort } from "@opencraft/access-control/collaboration";
export function createConversationExecution(
  getAppHost: () => AppHostServer,
  options: { serverId: string; hostId: string; engine?: string },
): ConversationExecutionPort;

export function createRoutedConversationExecution(
  getAppHost: () => AppHostServer,
  options: {
    machineId: string;
    engines: string[];
    agentHostId?: string;
    getInputs?: (engine: string) => Promise<unknown>;
  },
): ConversationExecutionPort;
export function callConversationHost(
  appHost: AppHostServer,
  binding: { hostId: string; threadId: string },
  requestId: string,
  method: string,
  params: Record<string, unknown>,
  submissionContext?: import("@opencraft/appserver-client/transport").TransportSubmissionContext,
  timeoutMs?: number,
): Promise<unknown>;
