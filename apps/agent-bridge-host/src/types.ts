import type { BridgeCommand, BridgeDeclaration, BridgeWireMessage } from '@opencraft/agent-bridge-protocol';
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
}
export interface OutboxEvent { seq: number; route: string; generation: string; payload: unknown }
export interface OutboxFence {
  readonly outboxId: string;
  readonly acknowledged: number;
  readonly high: number;
}

export function isOutboxId(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
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
