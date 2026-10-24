import { lstatSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readPrivateJson } from '../../identity-core/src/node.js';
import { HUB_SETTINGS_PATH } from './contract.js';
import { HubNetwork, readCommand, sameOriginJson } from './node.js';

function send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); res.end(JSON.stringify(value)); }
/** Optional same-machine relay owner; its credential never leaves the Headless process. */
export async function createHubController(file: string, localState: string) {
  let configured = false;
  try { lstatSync(file); configured = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!configured) {
    const node = new HubNetwork(localState);
    return { node, handle: async (req: IncomingMessage, res: ServerResponse, operator: () => string | null) => {
      if (new URL(req.url ?? '/', 'http://hub.invalid').pathname !== HUB_SETTINGS_PATH) return false;
      const actor = operator();
      if (!actor) { send(res, 403, { error: 'administrator_required' }); return true; }
      if (req.method === 'GET') { send(res, 200, node.snapshot()); return true; }
      if (req.method !== 'POST' || !sameOriginJson(req)) { send(res, 403, { error: 'same_origin_json_required' }); return true; }
      try { const input = await readCommand(req); const current = operator(); if (!current) { send(res, 403, { error: 'administrator_required' }); return true; }
        const result = node.command(input, current); send(res, 'conflict' in result ? 409 : 200, result); } catch { send(res, 400, { error: 'invalid_hub_change' }); } return true;
    }, close: () => node.close() };
  }
  const config = await readPrivateJson(file) as { schemaVersion: number; endpoint: string; credential: string };
  if (!config || config.schemaVersion !== 1 || Object.keys(config).some(k => !['schemaVersion', 'endpoint', 'credential'].includes(k))
    || typeof config.credential !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(config.credential)) throw new Error('Invalid Hub controller configuration');
  const endpoint = new URL(config.endpoint);
  if (endpoint.origin !== config.endpoint || endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1') throw new Error('Hub controller requires loopback');
  return { node: null, close() {}, async handle(req: IncomingMessage, res: ServerResponse, operator: () => string | null) {
    if (new URL(req.url ?? '/', 'http://hub.invalid').pathname !== HUB_SETTINGS_PATH) return false;
    if (!operator()) { send(res, 403, { error: 'administrator_required' }); return true; }
    if (req.method !== 'GET' && (req.method !== 'POST' || !sameOriginJson(req))) { send(res, 403, { error: 'same_origin_json_required' }); return true; }
    let input: Record<string, unknown> | undefined;
    try { if (req.method === 'POST') input = await readCommand(req); } catch { send(res, 400, { error: 'invalid_hub_change' }); return true; }
    const actor = operator(); if (!actor) { send(res, 403, { error: 'administrator_required' }); return true; }
    await new Promise<void>(resolve => {
      const upstream = httpRequest(config.endpoint + '/__opencraft_hub/operator', { method: req.method,
        headers: { authorization: 'Bearer ' + config.credential, 'content-type': 'application/json', 'x-opencraft-hub-operator': Buffer.from(actor).toString('base64url') } }, response => {
        res.writeHead(response.statusCode ?? 502, { 'content-type': 'application/json', 'cache-control': 'private, no-store' });
        response.on('error', () => { res.destroy(); resolve(); }); response.pipe(res); response.once('end', resolve);
      });
      upstream.setTimeout(5000, () => upstream.destroy()); upstream.on('error', () => { if (!res.headersSent) send(res, 503, { error: 'hub_unavailable' }); else res.destroy(); resolve(); });
      res.once('close', () => { upstream.destroy(); resolve(); }); upstream.end(input ? JSON.stringify(input) : undefined);
    }); return true;
  } };
}
