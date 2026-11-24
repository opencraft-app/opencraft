import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { HUB_SETTINGS_PATH } from './contract.js';
import { readCommand, sameOriginJson } from './node.js';
import { openHubNode } from './open.js';
import type { HubStatePort } from './state-port.js';

function send(res: ServerResponse, status: number, value: unknown) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'private, no-store' }); res.end(JSON.stringify(value)); }
/**
 * Optional same-machine relay owner; its credential never leaves the Headless process.
 * Its persistent state (the remote controller configuration, or the node's own
 * state and its single writer) comes from the Hub state port.
 */
export async function createHubController(state: HubStatePort) {
  const config = await state.readController();
  if (!config) {
    const { node, close } = await openHubNode(await state.openNode());
    return { node, handle: async (req: IncomingMessage, res: ServerResponse, operator: () => string | null) => {
      if (new URL(req.url ?? '/', 'http://hub.invalid').pathname !== HUB_SETTINGS_PATH) return false;
      const actor = operator();
      if (!actor) { send(res, 403, { error: 'administrator_required' }); return true; }
      if (req.method === 'GET') { send(res, 200, node.snapshot()); return true; }
      if (req.method !== 'POST' || !sameOriginJson(req)) { send(res, 403, { error: 'same_origin_json_required' }); return true; }
      try { const input = await readCommand(req); const current = operator(); if (!current) { send(res, 403, { error: 'administrator_required' }); return true; }
        const result = input.action==='connect'&&typeof input.relay==='string'
          ? await node.connectEndpoint(input.relay,{publishOrigin:typeof input.publishOrigin==='string'?input.publishOrigin:undefined,trustIdentity:input.trustIdentity===true,authorize:()=>operator()===current},current)
          : await node.apply(input, current); send(res, 'conflict' in result ? 409 : 200, result); } catch { send(res, 400, { error: 'invalid_hub_change' }); } return true;
    }, close };
  }
  return { node: null, async close() {}, async handle(req: IncomingMessage, res: ServerResponse, operator: () => string | null) {
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
