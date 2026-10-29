import { createHash } from 'node:crypto';

const fault = (status, code) => Object.assign(new Error(code), { status, code });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
export function projectConversationMetadata(serverId, thread, includeTitle = false, recovery = null) {
  const status = thread.status?.type;
  const flags = thread.status?.activeFlags ?? [];
  const attention = status !== 'active' ? null : flags.includes('waitingOnApproval') ? 'approval' : flags.includes('waitingOnUserInput') ? 'question' : null;
  return { ref: { serverId, threadId: thread.id }, projectId: thread.projectId ?? null, cwd: thread.cwd ?? null,
    runtime: attention ? 'awaiting_interaction' : recovery?.state === 'scheduled' ? 'recovering'
      : recovery?.state === 'unconfirmed' ? 'unknown' : recovery?.state === 'exhausted' ? 'failed'
      : status === 'active' ? 'running' : status === 'idle' ? 'idle' : status === 'systemError' ? 'failed' : 'unknown',
    currentTurnId: null, recovery, attention: attention ? { kind: attention, interactionId: null } : null,
    observedAt: Date.now(), ...(includeTitle && typeof thread.name === 'string' ? { title: thread.name } : {}) };
}

/** One native item at a time, including continuation inside a very long message.
 * The cursor binds the resource, native metadata revision and current item hash.
 * No history mirror and no full-history read is used. */
export async function readConversationPage(invoke, ref, cursor) {
  const metadata = (await invoke('thread/read', { includeTurns: false })).thread;
  if (metadata?.id !== ref.threadId) throw fault(404, 'conversation_unavailable');
  const tail = await invoke('thread/items/list', { limit: 1, sortDirection: 'desc', cursor: null });
  const watermark = digest([ref, metadata.updatedAt ?? null, tail.data?.[0] ?? null]);
  let position = { version: 1, ref, watermark, nativeCursor: null, offset: 0, itemHash: null };
  if (cursor) {
    try {
      const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed.version !== 1 || JSON.stringify(parsed.ref) !== JSON.stringify(ref)
        || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > 100_000_000
        || parsed.nativeCursor !== null && typeof parsed.nativeCursor !== 'string'
        || parsed.itemHash !== null && typeof parsed.itemHash !== 'string') throw Error();
      position = parsed;
    } catch { throw fault(400, 'invalid_cursor'); }
    if (position.watermark !== watermark) throw fault(409, 'history_changed');
  }
  const page = await invoke('thread/items/list', { limit: 1, sortDirection: 'asc', cursor: position.nativeCursor });
  if (!Array.isArray(page.data) || page.data.length > 1) throw fault(503, 'invalid_history_page');
  const source = page.data[0], item = source?.item;
  const itemHash = source ? digest(source) : null;
  if (position.itemHash !== null && position.itemHash !== itemHash) throw fault(409, 'history_changed');
  const content = item?.type === 'agentMessage' ? item.text : item?.type === 'userMessage'
    ? (item.content ?? []).filter(part => part.type === 'text').map(part => part.text).join('\n') : null;
  const points = typeof content === 'string' ? Array.from(content) : [];
  if (position.offset > points.length) throw fault(400, 'invalid_cursor');
  const text = points.slice(position.offset, position.offset + 2000).join('');
  const continuing = position.offset + 2000 < points.length;
  const nextCursor = continuing ? encode({ ...position, offset: position.offset + 2000, itemHash })
    : page.nextCursor ? encode({ ...position, nativeCursor: page.nextCursor, offset: 0, itemHash: null }) : null;
  const after = (await invoke('thread/read', { includeTurns: false })).thread;
  const tailAfter = await invoke('thread/items/list', { limit: 1, sortDirection: 'desc', cursor: null });
  if (watermark !== digest([ref, after?.updatedAt ?? null, tailAfter.data?.[0] ?? null])) throw fault(409, 'history_changed');
  return { entries: content === null ? [] : [{ turnId: source.turnId ?? null, itemId: item.id,
    role: item.type === 'userMessage' ? 'user' : 'assistant', offset: position.offset, text }],
    watermark, latestTurnId: tail.data?.[0]?.turnId ?? null, nextCursor, truncated: nextCursor !== null };
}
