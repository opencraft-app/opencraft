import { realpath } from 'node:fs/promises';
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
export function conversationScopes(state, hostId, threadId) {
  const scopes = new Set(['conversation:' + JSON.stringify([hostId, threadId])]);
  try {
    const bindings = JSON.parse(state?.values.bindings ?? '[]');
    if (Array.isArray(bindings)) for (const binding of bindings)
      if (binding?.hostId === hostId && binding.threadId === threadId && typeof binding.scopeId === 'string') scopes.add(binding.scopeId);
  } catch {}
  return scopes;
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

/** Operation-local index. Never cache mutable reducer drafts across calls. */
export function sessionLinkIndex(state) {
  const result = new Map();
  try {
    const storage = JSON.parse(state?.values.storage ?? '{}');
    const pages = JSON.parse(state?.values.pages ?? '[]'), tabs = JSON.parse(state?.values.tabs ?? '[]');
    if (!storage || typeof storage !== 'object' || Array.isArray(storage) || !Array.isArray(pages) || !Array.isArray(tabs)) return result;
    const byPage = new Map(), byTabPage = new Map(), leases = new Set();
    // Preserve first-match behavior. A null record stops the old find callback;
    // records after it must not become new authorization through this index.
    for (const page of pages) { if (page === null) break; if (!byPage.has(page.id)) byPage.set(page.id, page); }
    for (const tab of tabs) { if (tab === null) break; if (!byTabPage.has(tab.pageId)) byTabPage.set(tab.pageId, tab); }
    for (const [pageId, value] of Object.entries(storage)) {
      if (typeof value !== 'string') continue;
      const lease = value.replace(':', '-');
      if (leases.has(lease)) continue;
      leases.add(lease);
      const page = byPage.get(pageId), tab = byTabPage.get(pageId);
      if (!page || !tab || page.ownerId !== tab.ownerId) continue;
      result.set(lease, { link: { pageId, tabId: tab.id, scopeId: page.ownerId, hostId: page.hostId ?? null },
        url: page.entries?.[page.index]?.url ?? null });
    }
  } catch { return new Map(); }
  return result;
}
export function linkedSessions(ownerId, state, index = sessionLinkIndex(state)) {
  return [...index].flatMap(([lease, entry]) => /^browser-[a-zA-Z0-9-]+$/.test(lease)
    ? [{ key: JSON.stringify([ownerId, lease]), ...entry }] : []);
}

/** Resolve canonical IDs and persisted draft aliases without parsing delimiters. */
export function browserConversation(state, link) {
  if (!link?.scopeId) return null;
  try {
    if (link.scopeId.startsWith('conversation:')) {
      const pair = JSON.parse(link.scopeId.slice('conversation:'.length));
      if (Array.isArray(pair) && pair.length === 2 && pair.every(v => typeof v === 'string' && v.length))
        return { hostId: pair[0], threadId: pair[1] };
    }
    const bindings = JSON.parse(state?.values.bindings ?? '[]');
    const binding = bindings.find(b => b.scopeId === link.scopeId);
    if (typeof binding?.hostId === 'string' && typeof binding?.threadId === 'string' && binding.threadId)
      return { hostId: binding.hostId, threadId: binding.threadId };
  } catch {}
  return null;
}

export function conversationResourceLinks(ownerId, state) {
  const links = new Map();
  for (const page of linkedSessions(ownerId, state ?? {values:{}})) {
    const owner = browserConversation(state, page.link);
    if (owner) links.set('page:' + page.key, owner);
  }
  try { for (const binding of JSON.parse(state?.values.bindings ?? '[]')) {
    if (typeof binding.scopeId === 'string' && typeof binding.hostId === 'string' && typeof binding.threadId === 'string' && binding.threadId)
      links.set('scope:' + binding.scopeId, {hostId:binding.hostId,threadId:binding.threadId});
  } } catch {}
  return links;
}
