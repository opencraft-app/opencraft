import { open, rename, unlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

/** One managed Gateway owns this file. Every writer (including checkpoints)
 * uses the same queue; native work never holds it. Publish only after fsync and
 * atomic replacement. A failed draft cannot leak into another writer's commit. */
export class BrowserStateFile {
  constructor(directory, saved) {
    this.directory = directory;
    this.current = saved ?? { schemaVersion: 1, pages: [], retired: [], states: [] };
    this.tail = Promise.resolve();
  }
  transact(reduce) {
    const operation = this.tail.then(async () => {
      const draft = structuredClone(this.current);
      const result = reduce(draft);
      if (result && typeof result.then === 'function') throw new Error('Browser state reducer must be synchronous');
      const temporary = join(this.directory, 'tabs-' + randomUUID() + '.tmp');
      let file;
      try {
        file = await open(temporary, 'wx', 0o600);
        await file.writeFile(JSON.stringify(draft)); await file.sync(); await file.close(); file = null;
        await rename(temporary, join(this.directory, 'tabs.json'));
        // Rename has committed: never publish an older snapshot after this point.
        this.current = draft;
        const directory = await open(this.directory, 'r');
        try { await directory.sync(); } finally { await directory.close(); }
      } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
      return result;
    });
    this.tail = operation.catch(() => {});
    return operation;
  }
}

export const sessionError = (code, message, retryable = false) => Object.assign(new Error(message), { code, retryable });
export function sessionLink(state, lease) {
  try {
    const storage = JSON.parse(state?.values.storage ?? '{}');
    const [pageId] = Object.entries(storage).find(([, value]) => typeof value === 'string' && value.replace(':', '-') === lease) ?? [];
    const page = JSON.parse(state?.values.pages ?? '[]').find(p => p.id === pageId);
    const tab = JSON.parse(state?.values.tabs ?? '[]').find(t => t.pageId === pageId);
    if (page && tab && page.ownerId === tab.ownerId) return { pageId, tabId: tab.id, scopeId: page.ownerId, hostId: page.hostId ?? null };
  } catch {}
  return null;
}
export const occupied = record => record.runtime?.kind !== 'absent' && record.lifecycle !== 'closed';

/** Linux abstract UDS is an OS-held writer mutex: exit releases it, no stale
 * PID/TTL lock deletion or second writer can overwrite a committed snapshot. */
export async function acquireBrowserStateWriter(directory) {
  const { createServer } = await import('node:net');
  const { createHash } = await import('node:crypto');
  const server = createServer(socket => socket.destroy());
  const name = '\0opencraft-browser-state-' + createHash('sha256').update(await realpath(directory)).digest('hex');
  await new Promise((resolve, reject) => { server.once('error', error => reject(error.code === 'EADDRINUSE' ? sessionError('BROWSER_UNAVAILABLE', 'Browser state writer is busy; reconnecting', true) : error)); server.listen(name, resolve); });
  server.on('error', () => {}); server.unref();
  return () => new Promise(resolve => server.close(resolve));
}

export function linkedSessions(ownerId, state) {
  try {
    const values = JSON.parse(state.values.storage ?? '{}');
    if (!values || typeof values !== 'object' || Array.isArray(values)) return [];
    return [...new Set(Object.values(values))].flatMap(value => {
      if (typeof value !== 'string' || !/^browser[:-][a-zA-Z0-9-]+$/.test(value)) return [];
      const lease = value.replace(':', '-'), link = sessionLink(state, lease);
      if (!link) return [];
      const page = JSON.parse(state.values.pages).find(p => p.id === link.pageId);
      return [{ key: JSON.stringify([ownerId, lease]), link, url: page.entries?.[page.index]?.url ?? null }];
    });
  } catch { return []; }
}
