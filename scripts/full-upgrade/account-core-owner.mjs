import { leasedOwner } from "./operator-lease.mjs";
import { createHash } from 'node:crypto';
import { request } from 'node:http';
import { readPrivateJson, invariant } from './durable.mjs';
import { ACCOUNT_CORE_RESPONSE_MAX_BYTES } from './account-core-limits.mjs';

/** Local split-account adapter. Caller owns signed recipes, deployment lock and supervision. */
export function accountCoreOwner(descriptorPath, leaseOptions) {
  const compact = leaseOptions?.summary === true;
  const rpc = async (action, input, path = compact && !action ? "/owner-handoff?summary=1" : "/owner-handoff") => {
    const descriptor = await readPrivateJson(descriptorPath);
    invariant(descriptor.schemaVersion === 1 && typeof descriptor.endpoint === 'string' && descriptor.endpoint.startsWith('/')
      && Number.isSafeInteger(descriptor.pid) && descriptor.pid > 0 && typeof descriptor.token === 'string' && descriptor.token.length >= 32,
    'invalid-account-core-descriptor');
    return new Promise((resolve, reject) => {
      const req = request({ socketPath: descriptor.endpoint, path, method: action ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json' } }, response => {
        const chunks = []; let size = 0;
        response.on('data', chunk => { size += chunk.length; if (size > (path.includes('/history?') ? 32768 : path.includes('summary=1') || compact ? 262144 : ACCOUNT_CORE_RESPONSE_MAX_BYTES)) response.destroy(new Error('account-core-response-limit')); else chunks.push(chunk); });
        response.on('error', reject);
        response.on('end', () => {
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            invariant(response.statusCode === 200, /^[-a-z]{1,64}$/.test(value.code ?? '') ? value.code : 'account-core-handoff-rejected');
            if (path.includes('/history?')) { resolve(value); return; }
            invariant(value.pid === descriptor.pid && value.handoff?.protocolVersion === 1 && value.handoff?.topology === 'split'
              && typeof value.handoff?.owner === 'string' && typeof value.handoff?.bootId === 'string', 'account-core-identity-unavailable');
            resolve(value);
          } catch (error) { reject(error); }
        });
      });
      req.setTimeout(action === 'renew-operator-lease' ? 2000 : 15000, () => req.destroy(new Error('account-core-control-timeout')));
      req.on('error', reject); req.end(action ? JSON.stringify({ action, ...input, ...(compact ? { summary: true } : {}) }) : undefined);
    });
  };
  async function history(snapshot) {
    invariant(Number.isSafeInteger(snapshot?.count) && snapshot.count >= 0 && /^[a-f0-9]{64}$/.test(snapshot.sha256), 'invalid-account-history-snapshot');
    const records = []; let after = 0;
    do {
      const page = await rpc(undefined, undefined, '/owner-handoff/history?' + new URLSearchParams({ count: String(snapshot.count), sha256: snapshot.sha256, after: String(after) }));
      invariant(page.snapshot?.count === snapshot.count && page.snapshot?.sha256 === snapshot.sha256 && Array.isArray(page.records)
        && (page.next === null ? records.length + page.records.length === snapshot.count
          : Number.isSafeInteger(page.next) && page.next === after + page.records.length && page.next > after && page.next < snapshot.count), 'invalid-account-history-page');
      records.push(...page.records); after = page.next;
    } while (after !== null);
    invariant(records.length === snapshot.count && createHash('sha256').update(JSON.stringify(records)).digest('hex') === snapshot.sha256, 'account-history-hash-mismatch');
    return records;
  }
  const lease = leasedOwner(rpc, leaseOptions);
  return {
    dispose: lease.dispose, summary: () => rpc(undefined, undefined, "/owner-handoff?summary=1"), history, snapshot: () => rpc(), acquireFence: lease.acquireFence, abortFence: lease.abortFence, inspectDrain: input => rpc('inspect', input),
    interruptForMaintenance: input => rpc('maintenance-interrupt', input),
    acceptMaintenanceUnknown: input => rpc('maintenance-accept-unknown', input),
    releaseWriter: lease.releaseWriter, coldReady: input => rpc('cold-ready', input),
    releaseFence: (input, ready) => rpc('resume', { ...input, identity: ready.ready.identity }),
  };
}
