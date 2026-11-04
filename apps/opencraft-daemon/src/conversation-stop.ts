import type { ConversationRef, ConversationStopObservation, ConversationStopResult } from '@opencraft/appserver-protocol/collaboration';

export class StopControlError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
export const unknownStopObservation = (ref: ConversationRef, targetTurnId: string): ConversationStopObservation =>
  ({ref,targetTurnId,turnState:'unknown',activeTurnId:null,source:'unknown',observedAt:Date.now()});
/** Only Native header evidence is projected; absence is unknown, not stopped. */
export function stopObservation(ref: ConversationRef, targetTurnId: string, value: unknown): ConversationStopObservation {
  const data=(value as {data?: unknown})?.data;
  if (!Array.isArray(data) || data.length > 5) throw new StopControlError(503,'stop_observation_unavailable');
  const states=['inProgress','completed','failed','interrupted'];
  const target=data.find(row=>row?.id===targetTurnId);
  const active=data.filter(row=>row?.status==='inProgress' && typeof row.id==='string');
  if (active.length > 1) throw new StopControlError(503,'stop_observation_unavailable');
  return {ref,targetTurnId,turnState:target && states.includes(target.status) ? target.status : 'unknown',
    activeTurnId:active[0]?.id ?? null,source:'native/thread/turns/list',observedAt:Date.now()};
}
export interface StopControlPort {
  observe(): Promise<ConversationStopObservation>;
  interrupt(admit: () => boolean): Promise<unknown>;
  assertCurrent(): void;
  suppressRecovery(): void;
}
/** Invoked under the existing per-Thread owner serialization, once per request. */
export async function stopConversation(ref: ConversationRef, expectedTurnId: string, port: StopControlPort): Promise<ConversationStopResult> {
  port.assertCurrent();
  const before=await port.observe();port.assertCurrent();
  if (before.activeTurnId !== expectedTurnId || before.turnState !== 'inProgress') throw new StopControlError(409,'stale_turn');
  let attempted=false,requestState: ConversationStopResult['requestState']='unknown';
  try {
    await port.interrupt(()=>{port.assertCurrent();port.suppressRecovery();attempted=true;return true;});
    requestState='acknowledged';
  } catch (error) {
    if (!attempted) throw error;
    // A failed/empty transport receipt cannot prove that Native did not stop.
  }
  let observation=unknownStopObservation(ref,expectedTurnId);
  try {observation=await port.observe();} catch { /* Keep independent submission and observation facts. */ }
  port.assertCurrent();
  return {ref,targetTurnId:expectedTurnId,requestState,observation};
}
