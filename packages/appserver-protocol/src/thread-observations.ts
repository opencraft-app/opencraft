import type { ConversationRef } from './collaboration';
export const THREAD_CONTEXT_METHOD = 'opencraft/thread-context/read';
export interface ThreadContextObservation {
  status: 'observed' | 'unknown';
  reason: 'no-recorded-usage' | 'missing-window' | 'invalid-record' | 'source-unavailable' | 'source-changed' | 'read-budget' | null;
  source: 'native-rollout/token_count';
  scope: 'latest-recorded-context-window';
  recordedAt: string | null;
  observedAt: number;
  usedTokens: number | null;
  contextWindow: number | null;
  breakdown: { inputTokens: number | null; cachedInputTokens: number | null; outputTokens: number | null; reasoningOutputTokens: number | null } | null;
}
export interface ConversationContext extends ThreadContextObservation { ref: ConversationRef }
export interface ConversationCommands {
  ref: ConversationRef;
  source: 'engine-advertised-slash-commands';
  observedAt: number;
  commands: { name: string }[];
}
export function unknownContext(reason: NonNullable<ThreadContextObservation['reason']>): ThreadContextObservation {
  return { status:'unknown',reason,source:'native-rollout/token_count',scope:'latest-recorded-context-window',recordedAt:null,observedAt:Date.now(),usedTokens:null,contextWindow:null,breakdown:null };
}
const object = (v:unknown):Record<string,unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string,unknown> : {};
const count = (v:unknown) => Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : null;
/** Never forward raw Native records, free-form errors, paths or credentials. */
export function projectContext(value:unknown):ThreadContextObservation {
  const v=object(value), fallback=unknownContext('invalid-record');
  if (v.status==='unknown') {
    const reasons=['no-recorded-usage','missing-window','invalid-record','source-unavailable','source-changed','read-budget'];
    return {...fallback,reason:reasons.includes(String(v.reason)) ? v.reason as typeof fallback.reason : 'invalid-record'};
  }
  const usedTokens=count(v.usedTokens),contextWindow=count(v.contextWindow),b=object(v.breakdown);
  if(v.status!=='observed'||v.source!==fallback.source||v.scope!==fallback.scope||usedTokens===null||!contextWindow
    ||typeof v.recordedAt!=='string'||v.recordedAt.length>40||!Number.isFinite(Date.parse(v.recordedAt))||count(v.observedAt)===null)return fallback;
  return {status:'observed',reason:null,source:fallback.source,scope:fallback.scope,usedTokens,contextWindow,recordedAt:new Date(Date.parse(v.recordedAt)).toISOString(),observedAt:v.observedAt as number,
    breakdown:{inputTokens:count(b.inputTokens),cachedInputTokens:count(b.cachedInputTokens),outputTokens:count(b.outputTokens),reasoningOutputTokens:count(b.reasoningOutputTokens)}};
}
export function projectCommands(value:unknown,ref:ConversationRef):ConversationCommands {
  const v=object(value);
  if(v.source!=='engine-advertised-slash-commands'||count(v.observedAt)===null||!Array.isArray(v.commands)||v.commands.length>256)throw Error('Invalid slash command observation');
  const commands=v.commands.map(value=>{const row=object(value);if(typeof row.name!=='string'||!/^\/?[a-zA-Z][a-zA-Z0-9_-]{0,63}$/u.test(row.name))throw Error('Invalid slash command name');return{name:row.name};});
  return {ref,source:'engine-advertised-slash-commands',observedAt:v.observedAt as number,commands};
}
