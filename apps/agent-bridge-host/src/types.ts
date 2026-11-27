import { BRIDGE_ERROR_CODES, type BridgeCommand, type BridgeDeclaration, type BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
import type { SandboxCommand } from '@opencraft/sandbox';
export interface Generation {
  id: string;
  digest: string;
  artifact: string;
  provider: BridgeDeclaration;
  launch: SandboxCommand;
}
export interface Command {
  commandId: string;
  serverId: string;
  threadId: string;
  method: Exclude<BridgeCommand, 'initialize'>;
  params: Record<string, unknown>;
}
export interface Receipt {
  commandId: string;
  digest: string;
  epoch: number;
  route: string;
  generation: string;
  method: string;
  state: 'registered' | 'dispatching' | 'accepted' | 'rejected' | 'unknown';
  response?: BridgeWireMessage;
  identities?: { nativeThreadId?: string; turn?: { nativeId: string; id: string } };
}
export interface OutboxEvent { seq: number; route: string; generation: string; payload: unknown }
export interface EphemeralEvent {
  readonly streamSeq: number;
  readonly afterSeq: number;
  readonly route: string;
  readonly generation: string;
  readonly payload: unknown;
}
export interface EphemeralEventPage {
  readonly streamId: string;
  readonly highStreamSeq: number;
  readonly reset: boolean;
  readonly events: readonly EphemeralEvent[];
}
export type BridgeStreamMessage =
  | { readonly kind: 'hello'; readonly streamId: string; readonly highStreamSeq: number }
  | { readonly kind: 'ephemeral'; readonly event: EphemeralEvent }
  | { readonly kind: 'outbox'; readonly high: number };
export interface OutboxFence {
  readonly outboxId: string;
  readonly acknowledged: number;
  readonly high: number;
}

/** High-frequency streaming notifications that carry incremental deltas rather than durable state transitions. */
export const EPHEMERAL_THREAD_NOTIFICATIONS: ReadonlySet<string> = new Set([
  'turn/plan/updated',
  'item/reasoning/summaryTextDelta',
  'item/reasoning/summaryPartAdded',
  'item/commandExecution/outputDelta',
  'item/fileChange/outputDelta',
  'item/fileChange/patchUpdated',
]);

export const BRIDGE_HISTORY_SELECTION_LIMIT = 1024;
export interface BridgeHistorySelection {
  readonly nativeIds: readonly string[];
  readonly publicTurnId?: string;
  readonly publicTurnIds?: readonly string[];
}

export function isOutboxId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}
export function isArchiveCommand(method: string): boolean {
  return method === "session/archive" || method === "session/unarchive";
}
export const routeKey = (serverId: string, threadId: string): string => JSON.stringify([serverId, threadId]);
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Expected object');
  return value as Record<string, unknown>;
}
export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 512) throw Error('Invalid identifier');
  return value;
}

/** Refusal before a command has entered custody. */
export function oversizedBridgeRequest(maxBytes: number) {
  return Object.assign(new Error("Bridge request exceeds its byte limit"), {
    code: BRIDGE_ERROR_CODES.frameTooLarge,
    kind: "explicit-reject",
    data: { code: "BRIDGE_REQUEST_TOO_LARGE", maxBytes },
  });
}
