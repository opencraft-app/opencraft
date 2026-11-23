import type { ConversationRef, ThreadOrchestrationSnapshot } from "@opencraft/appserver-protocol/collaboration";
import type { AssistantThreadAllocation, AssistantThreadStore } from "./assistant-thread-store.js";
import type { AutomationCaller, AutomationLedger } from "./automation-ledger.js";
import type { AutomationRunState } from "./automation.js";
import type { ChannelSyncCommand, ChannelSyncResult } from "./native-channel-sync.js";
import type { CommunicationCommand, CommunicationResult } from "./communication-command.js";
import type { ExecutionRequestState } from "./execution-request-state.js";
import type { OrchestrationMessageOrigin } from "./orchestration-authority.js";
import type { ParentNotification, WaitTicket } from "./orchestration-ledger.js";
import type { PersonalAssistants } from "./personal-assistants.js";
import type { ThreadAccessPolicy } from "./thread-access.js";

/**
 * The owner Worker RPC of the orchestration runtime domain: every method the
 * domain serves, the payload `OrchestrationRuntimeWorker` sends with it and the
 * result it reads back. Both sides consume this map, so a payload that drifts
 * on either side fails the typecheck. Type-only apart from the method set, so
 * the network thread can import it without loading the SQL domain.
 */
type NoInput = Record<string, never>;
type Ledger = AutomationLedger;
type AutomationMutation = { caller: AutomationCaller; command: string; body: Record<string, unknown>; key: unknown };

/** `AutomationLedger` operations, as `ProjectAutomations` and the broker request them. */
export interface AutomationOperations {
  command: { input: Omit<AutomationMutation, "key"> & { key?: unknown }; result: ReturnType<Ledger["command"]> };
  grantReplay: { input: AutomationMutation; result: ReturnType<Ledger["grantReplay"]> };
  grant: { input: AutomationMutation; result: ReturnType<Ledger["grantCommand"]> };
  eligible: { input: NoInput; result: ReturnType<Ledger["eligible"]> };
  recover: { input: NoInput; result: void };
  claim: { input: { id: string; revision: number; occurrenceId: string }; result: ReturnType<Ledger["claim"]> };
  settle: {
    input: { key: string; state: AutomationRunState; result?: unknown; proof?: string };
    result: ReturnType<Ledger["settle"]>;
  };
  delegation: { input: { key: string; sourceThreadId: string }; result: ReturnType<Ledger["delegation"]> };
  enqueue: { input: { key: string; id: string; threadId: string }; result: ReturnType<Ledger["enqueue"]> };
  projection: { input: NoInput; result: ReturnType<Ledger["projection"]> };
  unknownRuns: { input: NoInput; result: ReturnType<Ledger["unknownRuns"]> };
  runGrant: { input: { key: string }; result: ReturnType<Ledger["runGrant"]> };
  checkRunGrant: { input: { key: string }; result: ReturnType<Ledger["checkRunGrant"]> };
  checkDelegation: { input: { id: string }; result: ReturnType<Ledger["checkDelegation"]> };
}
export type AutomationOperation = keyof AutomationOperations;
export type AutomationInput<O extends AutomationOperation> = AutomationOperations[O]["input"];
export type AutomationResult<O extends AutomationOperation> = AutomationOperations[O]["result"];
/** The `automation` payload: one ledger operation at the caller's clock. */
export type AutomationRequest = {
  [O in AutomationOperation]: { operation: O; input: AutomationInput<O>; now: number };
}[AutomationOperation];
/** Builds the payload for one operation; the union cannot follow a generic `O` by itself. */
export function automationRequest<O extends AutomationOperation>(
  operation: O,
  input: AutomationInput<O>,
  now: number,
): AutomationRequest {
  return { operation, input, now } as AutomationRequest;
}

/** One assistant input admission still held by a queued execution request. */
export interface AssistantAdmission {
  threadId: string;
  grant: NonNullable<OrchestrationMessageOrigin["assistantGrant"]>;
  authority: ReturnType<AssistantThreadStore["guard"]>;
  takenOver: boolean;
}

export interface OrchestrationRuntimeMethods {
  claimTitleWrite: { payload: { operationId: string }; result: boolean };
  finishTitleWrite: { payload: { toolCallKey: string; result: unknown }; result: void };
  inheritChildCreator: { payload: { parent: ConversationRef; child: ConversationRef }; result: ThreadAccessPolicy };
  personalAssistantAssignments: { payload: { after: string }; result: ReturnType<PersonalAssistants["assignments"]> };
  channelSync: { payload: ChannelSyncCommand; result: ChannelSyncResult };
  assistantAllocation: {
    payload: AssistantThreadAllocation;
    result: ReturnType<AssistantThreadStore["recordAllocation"]>;
  };
  assistantAdmissions: { payload: NoInput; result: AssistantAdmission[] };
  communication: { payload: CommunicationCommand; result: CommunicationResult };
  /** The result depends on the operation; see `AutomationResult`. */
  automation: { payload: AutomationRequest; result: unknown };
  observe: { payload: { snapshot: ThreadOrchestrationSnapshot; now: number }; result: void };
  admission: { payload: { threadId: string; inputId: string }; result: Record<string, unknown> | null };
  executionAuthority: {
    payload: { threadId: string; execution: { inputId?: string; turnId?: string } };
    result: Record<string, unknown> | null;
  };
  updateExecution: { payload: ExecutionRequestState; result: void };
  targets: { payload: { includeTerminal: boolean; now: number }; result: string[] };
  work: { payload: { now: number }; result: { waits: WaitTicket[]; notifications: ParentNotification[] } };
  pendingAcks: { payload: NoInput; result: string[] };
  acknowledge: { payload: { operationId: string }; result: void };
}
export type OrchestrationRuntimeMethod = keyof OrchestrationRuntimeMethods;
export type OrchestrationRuntimePayload<M extends OrchestrationRuntimeMethod> =
  OrchestrationRuntimeMethods[M]["payload"];
export type OrchestrationRuntimeResult<M extends OrchestrationRuntimeMethod> = OrchestrationRuntimeMethods[M]["result"];
/** One request as the domain receives it, discriminated by `method`. */
export type OrchestrationRuntimeRequest = {
  [M in OrchestrationRuntimeMethod]: { method: M; payload: OrchestrationRuntimePayload<M> };
}[OrchestrationRuntimeMethod];

const METHODS: Readonly<Record<OrchestrationRuntimeMethod, true>> = {
  claimTitleWrite: true,
  finishTitleWrite: true,
  inheritChildCreator: true,
  personalAssistantAssignments: true,
  channelSync: true,
  assistantAllocation: true,
  assistantAdmissions: true,
  communication: true,
  automation: true,
  observe: true,
  admission: true,
  executionAuthority: true,
  updateExecution: true,
  targets: true,
  work: true,
  pendingAcks: true,
  acknowledge: true,
};

/**
 * Turns a message received by an owner entry into a request. Only the method
 * name is checked (an unknown one takes the domain's existing error); the
 * payload is trusted as typed because the only sender is this package's
 * `OrchestrationRuntimeWorker`, which builds it from this map inside the same
 * process, over a Worker port or the Server core owner port that no remote
 * party can write to. Call it only at those owner entries.
 */
export function orchestrationRuntimeRequest(method: unknown, payload: unknown): OrchestrationRuntimeRequest {
  if (typeof method !== "string" || !Object.hasOwn(METHODS, method))
    throw new Error("Unsupported orchestration storage operation");
  return { method, payload } as OrchestrationRuntimeRequest;
}
