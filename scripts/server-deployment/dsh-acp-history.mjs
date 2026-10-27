import { createRequire } from 'node:module';
import { realpath, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { TranscriptReadCache } from '../../packages/native-history-node/src/transcript-read-cache.ts';
import { projectDshNativeEvents } from '../../apps/local-agent-host/src/dsh-appserver-adapter.ts';

/** DSH 0.2 moved a ToolResult payload onto the message itself. Adapt only
 * this wire shape before the existing shared projection; retain native events. */
export function normalizeDshAcpNativeEvent(event) {
  const message = event?.data?.message;
  if (event.type !== 'tool/result' || typeof message?.toolCallId !== 'string' || !Array.isArray(message.content)
    || message.content.some(block => block?.type === 'tool-result')) return event;
  return { ...event, data: { ...event.data, message: { ...message, content: [{ type: 'tool-result', toolCallId: message.toolCallId,
    content: message.content, isError: message.isError === true }] } } };
}

/** Read-only use of the configured native DSH persistence implementation.
 * It registers no Agent, LLM, SessionStore, watcher or write handle. Native
 * decompression, format validation and event meaning stay with that runtime. */
export async function createDshAcpHistory({ dshEntry, nativeHome, cacheDirectory, compression = 'zstd' }) {
  const require = createRequire(dshEntry);
  const [{ Context }, backend] = await Promise.all([
    import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href),
    import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-persistence-jsonl')).href),
  ]);
  const context = new Context();
  const fiber = context.plugin(backend, { root: nativeHome, compression });
  await fiber;
  const persistence = context.sessionPersistence, instance = randomUUID();
  const snapshots = new Map();
  const header = async id => {
    const observation = await persistence.stat(id);
    if (!observation) throw new Error('DSH native session is unavailable');
    return observation;
  };
  const cache = new TranscriptReadCache(cacheDirectory, {
    async readThread(id) {
      const { header: meta } = await header(id);
      return { id, cwd: meta.cwd ?? '', createdAt: Math.floor(meta.createdAt / 1000), updatedAt: Math.floor(meta.createdAt / 1000), turns: [], path: null };
    },
    async observeSnapshotSource(id) {
      snapshots.delete(id);
      const observation = await header(id), root = await realpath(nativeHome), info = await stat(root);
      return { path: root, key: JSON.stringify(['dsh-acp', root, instance, id]), identity: `${info.dev}:${info.ino}:${id}`,
        watermark: String(observation.revision), position: observation.sizeBytes ?? 0,
        async validate() { if (await realpath(nativeHome) !== root) throw new Error('DSH native history root changed'); },
      };
    },
    async listTurns(id, cursor, limit) {
      let snapshot = snapshots.get(id);
      if (!snapshot) {
        snapshot = (async () => {
          const handle = await persistence.open(id, 'read');
          try {
            const read = await handle.read();
            return projectDshNativeEvents(id, read.events.map(event => ({ event: normalizeDshAcpNativeEvent(event) })), { cwd: handle.header.cwd, running: true }).reverse();
          } finally { await handle.close(); }
        })();
        snapshots.set(id, snapshot);
      }
      try {
        const turns = await snapshot, offset = cursor === null ? 0 : Number(cursor);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid DSH native transcript cursor');
        const nextCursor = offset + limit < turns.length ? String(offset + limit) : null;
        if (nextCursor === null) snapshots.delete(id);
        return { data: turns.slice(offset, offset + limit), nextCursor };
      } catch (error) { snapshots.delete(id); throw error; }
    },
  });
  return {
    read(nativeSessionId, params) { return cache.page(nativeSessionId, params.cursor ?? null, params.limit ?? 10); },
    async close() { await cache.close(); await fiber.dispose(); },
  };
}
