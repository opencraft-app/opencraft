import type { ThreadOrchestrationSnapshot } from "@opencraft/appserver-protocol/collaboration";

/** Engine identity is independent of the gateway connection and native protocol. */
export type AgentDriverKind = "codex" | "pi" | "dsh" | "acp" | "claude-code";
export interface AgentOrchestrationPort {
  readonly tools: readonly { readonly name: string; readonly description: string; readonly inputSchema: Readonly<Record<string, unknown>> }[];
  call(threadId: string, turnId: string, callId: string, name: string, args: Record<string, unknown>, signal: AbortSignal, inputId?: string): Promise<unknown>;
}
export interface AgentDriverCreation {
  threadId: string;
  driverKind?: AgentDriverKind;
  generationId?: string;
  durability?: "immediate" | "pending_first_turn";
}
/** Trusted control plane contract. The independent Host owns idempotent native
 * creation and callback replay; an ordinary native mutation is never retried. */
export interface AgentDriverContract {
  prepare?(operationId: string, sourceThreadId: string, args: Record<string, unknown>, canAdmit: () => boolean, callbackIncarnation?: string): Promise<Record<string, unknown>>;
  create(operationId: string, sourceThreadId: string, settings: Record<string, unknown>, canAdmit: () => boolean): Promise<AgentDriverCreation | { rejected: { status: number } }>;
  acknowledge?(operationId: string): Promise<boolean | void>;
  snapshot(threadId: string): Promise<ThreadOrchestrationSnapshot>;
  inspect?(threadId: string, limit: number): Promise<{ entries: Array<{ turnId: string; role: string; text: string }> }>;
}
