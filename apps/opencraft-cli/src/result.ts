import type { CollaborationClient } from '@opencraft/appserver-client/collaboration';
import type { ConversationRef, ConversationResultTarget, ConversationExactResult } from '@opencraft/appserver-protocol/collaboration';
import { CliError, classify } from './errors';

export function resultTarget(request?: string, key?: string, turn?: string): ConversationResultTarget {
  const parameters = [request === undefined ? null : '--request', key === undefined ? null : '--key', turn === undefined ? null : '--turn'].filter(value => value !== null);
  if ([request,key,turn].filter(v=>v!==undefined).length !== 1 || [request,key,turn].some(v=>v!==undefined && (!v.trim() || /[\x00-\x1f]/u.test(v))))
    throw new CliError(2,'INVALID_ARGUMENTS','Choose exactly one of --request, --key or --turn.', false, { parameters: parameters.length ? parameters : ['--request','--key','--turn'], reason: parameters.length === 0 ? 'missing-target' : parameters.length > 1 ? 'conflicting-targets' : 'invalid-value' });
  return request !== undefined ? {requestId:request} : key !== undefined ? {operationKey:key} : {turnId:turn!};
}
export function resultTimeout(value = '30s') {
  const m = /^(\d+)(ms|s|m)?$/u.exec(value);
  const ms = m ? Number(m[1]) * (m[2] === 'm' ? 60000 : m[2] === 'ms' ? 1 : 1000) : NaN;
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 3600000) throw new CliError(2,'INVALID_ARGUMENTS','Use a timeout from 1ms to 1h.', false, { parameters: ['--timeout'], reason: 'invalid-value' });
  return ms;
}
export async function waitForResult(client: CollaborationClient, ref: ConversationRef, target: ConversationResultTarget, timeout: number, output = false) {
  const deadline = Date.now() + timeout;
  let latest: ConversationExactResult | null = null;
  while (Date.now() < deadline) {
    try {
      latest = await client.exactResult(ref,target,false,undefined,Math.max(1,Math.min(11000,deadline-Date.now())));
    } catch(error) {
      if (classify(error).code !== 'HISTORY_READ_UNAVAILABLE') throw error;
    }
    if (latest?.matched) {
      if (!output || !latest.turnId) return latest;
      return await finalOutput(client,ref,latest,deadline);
    }
    await new Promise(resolve=>setTimeout(resolve,Math.min(250,Math.max(0,deadline-Date.now()))));
  }
  throw new CliError(7,'TIMEOUT','Target Turn has not reached a confirmed terminal state.',false,{target,result:latest});
}

async function finalOutput(client: CollaborationClient, ref: ConversationRef, terminal: ConversationExactResult, deadline: number) {
  let result: ConversationExactResult = {...terminal,entries:[],complete:false};
  let cursor: string | undefined;
  const entries: ConversationExactResult['entries'] = [];
  const seen = new Set<string>();
  while (Date.now() < deadline) {
    let page: ConversationExactResult;
    try { page = await client.exactResult(ref,{turnId:terminal.turnId!},true,cursor,Math.max(1,Math.min(11000,deadline-Date.now()))); }
    catch(error) { const fault=classify(error); throw new CliError(fault.exitCode,fault.code,fault.message,fault.retryable,{target:{turnId:terminal.turnId},result}); }
    if (page.turnId !== terminal.turnId || !page.matched || cursor !== undefined && page.watermark !== result.watermark)
      throw new CliError(5,'HISTORY_CHANGED','Target final output changed. Read output again from the first page.',false,{target:{turnId:terminal.turnId}});
    entries.push(...page.entries);
    result = {...page,requestId:terminal.requestId,deliveryState:terminal.deliveryState,entries:[...entries]};
    if (!page.nextCursor) return result;
    if (seen.has(page.nextCursor)) throw new CliError(7,'HISTORY_READ_UNAVAILABLE','Output cursor did not advance.',false,{target:{turnId:terminal.turnId},result:{...result,complete:false}});
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
  throw new CliError(7,'TIMEOUT','Turn is terminal; final output is incomplete. Continue thread output with the returned cursor.',false,{target:{turnId:terminal.turnId},result:{...result,complete:false}});
}
