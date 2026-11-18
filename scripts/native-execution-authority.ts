import { randomUUID } from 'node:crypto';
import type { ActorContext } from '@opencraft/identity-core/actors';

interface Admission { context: ActorContext; fingerprint: string; authorityId: string; threadId: string; inputId: string; turnId: string | null }
const identity = (...parts: string[]) => JSON.stringify(parts);
const denied = () => new Error('Native execution authority unavailable');
function text(value: string) { if (!value || value.length > 512) throw denied(); return value; }

/** A trusted physical Host's live submission attestations. This is deliberately
 * not durable recovery or an effect ledger: restart/lost transport removes
 * authority, while domain receipts remain durable and must never be replayed.
 * Viewers and model arguments cannot create or transfer these attestations. */
export class NativeExecutionAuthority {
  private readonly inputs = new Map<string, Admission>();
  private readonly turns = new Map<string, Admission>();
  constructor(private readonly authorize: (context: ActorContext, threadId: string) => void,
    private readonly now = Date.now, private readonly capacity = 512) {}
  private current(entry: Admission) {
    if (entry.context.expiresAt <= this.now()) throw denied();
    this.authorize(entry.context, entry.threadId);
  }
  admit(context: ActorContext, threadId: string, inputId: string) {
    text(threadId); text(inputId);
    this.authorize(context, threadId);
    if (!Number.isFinite(context.expiresAt) || context.expiresAt <= this.now()) throw denied();
    for (const [key, entry] of this.inputs) if (entry.context.expiresAt <= this.now()) this.inputs.delete(key);
    const key = identity(threadId, inputId), previous = this.inputs.get(key);
    if (previous) {
      if (previous.fingerprint !== JSON.stringify(context)) throw denied();
      this.current(previous); return;
    }
    // A steer cannot transfer an already executing turn to another human.
    for (const entry of this.turns.values()) if (entry.threadId === threadId
      && (entry.context.actorId !== context.actorId || entry.context.generation !== context.generation)) throw denied();
    if (this.inputs.size >= this.capacity || this.turns.size >= this.capacity) throw new Error('Native execution authority capacity exceeded');
    this.inputs.set(key, {context:Object.freeze({...context, expiresAt:Math.min(context.expiresAt, this.now() + 86_400_000)}),
      fingerprint:JSON.stringify(context), authorityId:randomUUID(), threadId, inputId, turnId:null});
  }
  started(threadId: string, inputId: string, turnId: string) {
    if (!turnId || turnId.length > 512) return;
    const entry = this.inputs.get(identity(threadId, inputId));
    if (!entry) return; // Native notifications alone never establish authority.
    try { this.current(entry); } catch { return; }
    if (entry.turnId && entry.turnId !== turnId) return;
    const key = identity(threadId, turnId), previous = this.turns.get(key);
    if (previous) { entry.turnId = turnId; return; } // Keep the original turn's authority across steering.
    entry.turnId = turnId; this.turns.set(key, entry);
  }
  source(threadId: string, execution: { inputId?: string; turnId?: string }) {
    const entry = execution.turnId ? this.turns.get(identity(threadId, execution.turnId))
      : execution.inputId ? this.inputs.get(identity(threadId, execution.inputId)) : undefined;
    if (!entry || !entry.turnId || execution.inputId && execution.inputId !== entry.inputId) throw denied();
    this.current(entry);
    return Object.freeze({context:entry.context, authorityId:entry.authorityId, turnId:entry.turnId});
  }
  ended(threadId: string, turnId: string) {
    this.turns.delete(identity(threadId, turnId));
    for (const [key, entry] of this.inputs) if (entry.threadId === threadId && entry.turnId === turnId) this.inputs.delete(key);
  }
  rejected(threadId: string, inputId: string) {
    const key = identity(threadId, inputId);
    if (!this.inputs.get(key)?.turnId) this.inputs.delete(key);
  }
  invalidate() { this.inputs.clear(); this.turns.clear(); }
}
