/** Document key; the Node composition keeps it as `server-information.json` in the data directory. */
export const SERVER_INFORMATION_DOCUMENT = 'server-information.json';
export const SERVER_INFORMATION_PATH = '/__opencraft_server_information';
/** A link destination, never an authentication origin, proxy route or fetch target. */
export function normalizePublicEntry(value) {
  if (typeof value !== 'string' || value.length > 2048) throw Error('invalid_public_url');
  const text = value.trim();
  if (!text) return '';
  if (!/^https?:\/\//iu.test(text) || /[\s\\\x00-\x1f\x7f]/u.test(text)) throw Error('invalid_public_url');
  let url;
  try { url = new URL(text); } catch { throw Error('invalid_public_url'); }
  if (url.username || url.password || text.includes('?') || text.includes('#') || !url.hostname
    || !/^\/(?:[A-Za-z0-9._~-]+\/?)*$/u.test(url.pathname)
    || text.replace(/^https?:\/\/[^/]+/iu, '').split('/').some(s => s === '.' || s === '..')) throw Error('invalid_public_url');
  return url.origin + url.pathname.replace(/\/+$/u, '');
}

const unavailable = () => Error('server_information_unavailable');
function parseStored(value) {
  if (value === null) return { revision: 0, publicUrl: '' };
  if (value?.schemaVersion !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.updatedBy !== 'string' || !Number.isSafeInteger(value.updatedAt)) throw unavailable();
  try { return { revision: value.revision, publicUrl: normalizePublicEntry(value.publicUrl) }; }
  catch { throw unavailable(); }
}

/**
 * One independently persisted server setting, not a per-browser subscription preference.
 * `documents` is a StateDocumentStore (`@opencraft/document-storage/state`); it
 * serializes updates and commits atomically, the revision fence stays here.
 */
export class ServerInformationStore {
  /** @param {import('@opencraft/document-storage/state').StateDocumentStore} documents */
  constructor(documents) { this.documents = documents; }
  async read() {
    let value;
    try { value = await this.documents.read(SERVER_INFORMATION_DOCUMENT); } catch { throw unavailable(); }
    return parseStored(value);
  }
  async write(revision, publicUrl, actorId, assertCurrent) {
    const normalized = normalizePublicEntry(publicUrl);
    if (!Number.isSafeInteger(revision) || revision < 0 || typeof actorId !== 'string' || !actorId) throw Error('invalid_server_information');
    let rejected;
    try {
      return await this.documents.update(SERVER_INFORMATION_DOCUMENT, current => {
        try {
          const previous = parseStored(current);
          if (previous.revision !== revision) throw Error('revision_conflict');
          // Recheck under the document lock, immediately before the commit boundary.
          assertCurrent();
          const next = { schemaVersion: 1, revision: revision + 1, publicUrl: normalized, updatedBy: actorId, updatedAt: Date.now() };
          return { result: { revision: next.revision, publicUrl: normalized }, next };
        } catch (error) { rejected = error; throw error; }
      });
    } catch (error) {
      if (rejected !== undefined && error === rejected) throw error;
      throw unavailable();
    }
  }
}

export function serverInformationHttp(store, authority) {
  return async (request, response) => {
    if (new URL(request.url ?? '/', 'http://information.invalid').pathname !== SERVER_INFORMATION_PATH) return false;
    const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' }); response.end(JSON.stringify(value)); };
    try {
      const access = authority(request);
      if (!access) { send(401, { error: 'human_authentication_required' }); return true; }
      const current = () => {
        const latest = authority(request);
        if (!latest || latest.actorId !== access.actorId) throw Error('account_changed');
        return latest;
      };
      if (request.method === 'GET') {
        const value = await store.read(), latest = current();
        send(200, { ...value, actorId: latest.actorId, canManage: latest.administrator }); return true;
      }
      if (request.method !== 'POST') { send(405, { error: 'method_not_allowed' }); return true; }
      if (!access.administrator) { send(403, { error: 'administrator_required' }); return true; }
      const origin = request.headers.origin;
      if (typeof origin !== 'string' || !(origin === access.origin || ['http:', 'https:'].some(p => origin === p + '//' + request.headers.host))
        || request.headers['sec-fetch-site'] === 'cross-site' || request.headers['content-type']?.split(';')[0] !== 'application/json') {
        send(403, { error: 'same_origin_required' }); return true;
      }
      let size = 0; const chunks = [];
      for await (const chunk of request) { size += Buffer.byteLength(chunk); if (size > 4096) { send(413, { error: 'too_large' }); return true; } chunks.push(Buffer.from(chunk)); }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('invalid_server_information'); }
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !['revision', 'publicUrl', 'expectedActorId'].includes(k))) throw Error('invalid_server_information');
      if (input.expectedActorId !== access.actorId) throw Error('account_changed');
      const value = await store.write(input.revision, input.publicUrl, access.actorId, () => {
        if (!current().administrator) throw Error('administrator_required');
      });
      const latest = current();
      send(200, { ...value, actorId: latest.actorId, canManage: latest.administrator });
    } catch (error) {
      const code = error?.message;
      const status = code === 'revision_conflict' || code === 'account_changed' ? 409 : code === 'administrator_required' ? 403
        : code === 'invalid_public_url' || code === 'invalid_server_information' ? 400 : 503;
      send(status, { error: status === 503 ? 'server_information_unavailable' : code });
    }
    return true;
  };
}
