import { request } from 'node:http';
import { readPrivateJson, invariant } from './durable.mjs';
import { ACCOUNT_CORE_RESPONSE_MAX_BYTES } from './account-core-limits.mjs';

/** Local split-account adapter. Caller owns signed recipes, deployment lock and supervision. */
export function accountCoreOwner(descriptorPath) {
  const rpc = async (action, input) => {
    const descriptor = await readPrivateJson(descriptorPath);
    invariant(descriptor.schemaVersion === 1 && typeof descriptor.endpoint === 'string' && descriptor.endpoint.startsWith('/')
      && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && typeof descriptor.token === 'string' && descriptor.token.length >= 32,
    'invalid-account-core-descriptor');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: descriptor.endpoint, path: '/owner-handoff', method: action ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > ACCOUNT_CORE_RESPONSE_MAX_BYTES) response.destroy(new Error('account-core-response-limit')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            invariant(response.statusCode === 200, 'account-core-handoff-rejected');
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            invariant(value.pid === descriptor.pid && value.handoff?.protocolVersion === 1 && value.handoff?.topology === 'split'
              && typeof value.handoff?.owner === 'string' && typeof value.handoff?.bootId === 'string', 'account-core-identity-unavailable');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(15000, () => req.destroy(new Error('account-core-control-timeout')));
      req.on('error', reject); req.end(action ? JSON.stringify({ action, ...input }) : undefined);
    });
  };
  return {
    snapshot: () => rpc(), acquireFence: input => rpc('fence', input), abortFence: input => rpc('abort', input), inspectDrain: input => rpc('inspect', input),
    releaseWriter: input => rpc('release', input), coldReady: input => rpc('cold-ready', input),
    releaseFence: (input, ready) => rpc('resume', { ...input, identity: ready.ready.identity }),
  };
}
