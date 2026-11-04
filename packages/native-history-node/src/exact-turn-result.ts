import { createHash } from 'node:crypto';
import type { AppServerTurn } from '@opencraft/appserver-protocol';
import type { ConversationTurnResult } from '@opencraft/appserver-protocol/collaboration';

export class ExactReadUnavailable extends Error {
  readonly code = 'HISTORY_READ_UNAVAILABLE';
}

export class ExactResultConflict extends Error {
  readonly code = 'history_changed';
}
/** One text chunk per page. No commentary, user input, tools or paths leave this projection. */
export function exactTurnResult(turnId: string, turn: AppServerTurn | undefined, watermark: string | null,
  output: boolean, cursor: string | null): ConversationTurnResult {
  const status = turn?.status;
  const turnState = typeof status === 'string' && ['inProgress','completed','failed','interrupted'].includes(status) ? status as ConversationTurnResult['turnState'] : 'unknown';
  const matched = ['completed','failed','interrupted'].includes(turnState);
  const base: ConversationTurnResult = { turnId, turnState, matched, source: 'native-transcript', watermark,
    entries: [], nextCursor: null, complete: false, finalUnavailable: false, observedAt: Date.now() };
  if (!output) return base;
  // Never publish a streaming partial as a completed final result.
  if (!matched || !turn || !watermark) { if (cursor) throw new ExactResultConflict('Target changed'); return base; }
  if(turn.itemsView !== 'full') return {...base,finalUnavailable:true};
  const unknownPhase = (turn.items ?? []).some(item => item.type === 'agentMessage' && item.phase !== 'commentary' && item.phase !== 'final_answer');
  const finals = (turn.items ?? []).filter(item => item.type === 'agentMessage' && item.phase === 'final_answer');
  let index = 0, offset = 0;
  if (cursor !== null) {
    try {
      const c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (Object.keys(c).some(k => !['v','watermark','index','offset'].includes(k)) || c.v !== 1 || c.watermark !== watermark
        || !Number.isSafeInteger(c.index) || c.index < 0 || !Number.isSafeInteger(c.offset) || c.offset < 0) throw Error();
      index = c.index; offset = c.offset;
    } catch { throw new ExactResultConflict('Target changed or invalid cursor'); }
  }
  if (!finals.length) { if (cursor) throw new ExactResultConflict('Target changed'); return { ...base, finalUnavailable: true }; }
  const item = finals[index];
  if (!item || item.type !== 'agentMessage' || typeof item.text !== 'string') throw new ExactResultConflict('Invalid final item');
  const text = Array.from(item.text);
  if (offset > text.length) throw new ExactResultConflict('Invalid final offset');
  const chunk = text.slice(offset, offset + 2000).join('');
  const nextOffset = offset + Array.from(chunk).length;
  const next = nextOffset < text.length ? { index, offset: nextOffset } : { index: index + 1, offset: 0 };
  return { ...base, entries: [{ itemId: item.id, phase: 'final_answer', offset, text: chunk }],
    nextCursor: next.index < finals.length ? Buffer.from(JSON.stringify({v:1,watermark,...next})).toString('base64url') : null,
    complete: next.index >= finals.length && !unknownPhase, finalUnavailable: unknownPhase };
}
export const targetWatermark = (threadId: string, turnId: string, epoch: string, source: string, hash: string) =>
  createHash('sha256').update(JSON.stringify([threadId,turnId,epoch,source,hash])).digest('hex');
