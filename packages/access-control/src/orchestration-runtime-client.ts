import type { ChannelSyncCommand, ChannelSyncResult } from "./native-channel-sync.js";
import type { CommunicationCommand, CommunicationResult } from "./communication-command.js";
import { AutomationError } from "./automation.js";
import { markOrchestrationRuntimeService } from "./orchestration-runtime-companion.js";
import type { ThreadAccessPolicy } from "./thread-access.js";
import type { ConversationRef, ThreadOrchestrationSnapshot } from "@opencraft/appserver-protocol/collaboration";
import type { ParentNotification, WaitTicket } from "./orchestration-ledger.js";
import type { ExecutionRequestState } from "./execution-request-state.js";
import type { AssistantThreadAllocation } from "./assistant-thread-store.js";
import type { PersonalAssistants } from "./personal-assistants.js";
import type { ExternalConversationRequest, ExternalConversationResult } from "./external-conversation.js";
import {
  automationRequest,
  type AssistantAdmission,
  type AutomationInput,
  type AutomationOperation,
  type AutomationResult,
  type OrchestrationRuntimeMethod,
  type OrchestrationRuntimePayload,
  type OrchestrationRuntimeResult,
} from "./orchestration-runtime-contract.js";

export interface OrchestrationRuntimeStorage {
  claimTitleWrite(operationId: string): Promise<boolean>;
  finishTitleWrite(toolCallKey: string, result: unknown): Promise<void>;
  observe(snapshot: ThreadOrchestrationSnapshot, now: number): Promise<void>;
  targets(includeTerminal: boolean, now: number): Promise<string[]>;
  work(now: number): Promise<{ waits: WaitTicket[]; notifications: ParentNotification[] }>;
  pendingAcks(): Promise<string[]>;
  acknowledge(operationId: string): Promise<void>;
}
/** The Server core owner's port for the orchestration runtime domain
 * (`orchestrationRuntimeOwnerMethods`), e.g. `openServerCoreOwner(...)`. */
export interface OrchestrationRuntimeOwner {
  readonly call: {
    orchestrationRuntime<M extends OrchestrationRuntimeMethod>(
      method: M,
      payload: OrchestrationRuntimePayload<M>,
    ): Promise<unknown>;
  };
}
export interface OrchestrationRuntimeTransport {
  readonly capacity: number;
  readonly ready: Promise<void>;
  request<M extends OrchestrationRuntimeMethod>(method: M, payload: OrchestrationRuntimePayload<M>): Promise<unknown>;
  close(): Promise<void>;
}

/** Borrow the core owner's command queue without taking ownership of its lifecycle. */
export function coreOrchestrationTransport(owner: OrchestrationRuntimeOwner): OrchestrationRuntimeTransport {
  return {
    capacity: 256,
    ready: Promise.resolve(),
    request: (method, payload) => owner.call.orchestrationRuntime(method, payload),
    close: () => Promise.resolve(),
  };
}

/** Common command client. The selected owner provides transport and storage. */
export class OrchestrationRuntimeClient implements OrchestrationRuntimeStorage {
  private readonly inFlight = new Set<Promise<unknown>>();
  private closing?: Promise<void>;

  constructor(private readonly transport: OrchestrationRuntimeTransport) {
    markOrchestrationRuntimeService(this);
  }

  start(): Promise<void> {
    return this.transport.ready;
  }

  private async request<M extends OrchestrationRuntimeMethod>(
    method: M,
    payload: OrchestrationRuntimePayload<M>,
  ): Promise<OrchestrationRuntimeResult<M>> {
    if (this.closing) throw new Error("Orchestration storage is closing");
    if (this.inFlight.size >= this.transport.capacity) throw new Error("Orchestration storage queue is full");
    const operation = this.transport.ready.then(() => this.transport.request(method, payload));
    this.inFlight.add(operation);
    try {
      return (await operation) as OrchestrationRuntimeResult<M>;
    } catch (error) {
      throw orchestrationRuntimeFailure(error);
    } finally {
      this.inFlight.delete(operation);
    }
  }

  externalConversation(input: ExternalConversationRequest): Promise<ExternalConversationResult> {
    return this.request("externalConversation", input);
  }
  inheritChildCreator(parent: ConversationRef, child: ConversationRef): Promise<ThreadAccessPolicy> {
    return this.request("inheritChildCreator", { parent, child });
  }
  claimTitleWrite(operationId: string): Promise<boolean> {
    return this.request("claimTitleWrite", { operationId });
  }
  finishTitleWrite(toolCallKey: string, result: unknown): Promise<void> {
    return this.request("finishTitleWrite", { toolCallKey, result });
  }
  automation<O extends AutomationOperation>(
    operation: O,
    input: AutomationInput<O>,
    now: number,
  ): Promise<AutomationResult<O>> {
    return this.request("automation", automationRequest(operation, input, now)) as Promise<AutomationResult<O>>;
  }
  observe(snapshot: ThreadOrchestrationSnapshot, now: number): Promise<void> {
    return this.request("observe", { snapshot, now });
  }
  targets(includeTerminal: boolean, now: number): Promise<string[]> {
    return this.request("targets", { includeTerminal, now });
  }
  work(now: number): Promise<{ waits: WaitTicket[]; notifications: ParentNotification[] }> {
    return this.request("work", { now });
  }
  pendingAcks(): Promise<string[]> {
    return this.request("pendingAcks", {});
  }
  acknowledge(operationId: string): Promise<void> {
    return this.request("acknowledge", { operationId });
  }
  recordAssistantThreadAllocation(
    value: AssistantThreadAllocation,
  ): Promise<OrchestrationRuntimeResult<"assistantAllocation">> {
    return this.request("assistantAllocation", value);
  }
  assistantAdmissions(): Promise<AssistantAdmission[]> {
    return this.request("assistantAdmissions", {});
  }
  admission(threadId: string, inputId: string): Promise<Record<string, unknown> | null> {
    return this.request("admission", { threadId, inputId });
  }
  executionAuthority(
    threadId: string,
    execution: { inputId?: string; turnId?: string },
  ): Promise<Record<string, unknown> | null> {
    return this.request("executionAuthority", { threadId, execution });
  }
  updateExecution(value: ExecutionRequestState): Promise<void> {
    return this.request("updateExecution", value);
  }
  personalAssistantAssignments(after: string): Promise<ReturnType<PersonalAssistants["assignments"]>> {
    return this.request("personalAssistantAssignments", { after });
  }
  synchronizeChannels(command: ChannelSyncCommand): Promise<ChannelSyncResult> {
    return this.request("channelSync", command);
  }
  communicate(command: CommunicationCommand): Promise<CommunicationResult> {
    return this.request("communication", command);
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      await Promise.allSettled(this.inFlight);
      await this.transport.close();
    })());
  }
}

/** Preserve domain failures across the owner transport. */
export function orchestrationRuntimeFailure(error: unknown): Error {
  const value = error as { message?: string; code?: unknown; status?: unknown } | null | undefined;
  if (typeof value?.status === "number" && typeof value.code === "string")
    return new AutomationError(value.code, value.status);
  if (error instanceof Error) return error;
  return Object.assign(new Error(value?.message), { code: value?.code });
}
