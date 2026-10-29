import { request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { invariant } from './durable.mjs';

/** Local authenticated adapter. Caller owns deployment lock and consumer supervision. */
export function codexRouterOwner(endpoint, tokenFile) {
  const rpc = async (action, input) => {
    const token = (await readFile(tokenFile, 'utf8')).trim();
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: endpoint, agent: false, path: '/owner-handoff', method: action ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > 1024 * 1024) response.destroy(new Error('router-response-limit')); else chunks.push(chunk); });
        response.on('error', reject); response.on('end', () => {
          try { invariant(response.statusCode === 200, 'router-handoff-rejected');
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            invariant(value.handoff?.protocolVersion === 1 && typeof value.handoff.owner === 'string', 'router-identity-unavailable'); resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('router-control-timeout'))); req.on('error', reject);
      req.end(action ? JSON.stringify({ action, ...input }) : undefined);
    });
  };
  return { snapshot: () => rpc(), acquireFence: input => rpc('fence', input), inspectDrain: input => rpc('inspect', input),
    abortFence: input => rpc('abort', input), releaseWriter: input => rpc('release', input), coldReady: input => rpc('cold-ready', input),
    releaseFence: (input, ready) => rpc('resume', { ...input, identity: ready.ready.identity }) };
}
