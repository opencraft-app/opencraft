import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export async function operatorLeaseClaim(ttlMs = 15000) {
  const stat = await readFile(`/proc/${process.pid}/stat`, 'utf8');
  return { version: 1, id: randomUUID(), controller: { pid: process.pid,
    startTime: stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/u)[19],
    bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim() }, ttlMs };
}
/** Only owns the intrinsic source fence. External gates/consumers belong to the controller. */
export function leasedOwner(rpc, { ttlMs = 15000, renewMs = 3000 } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000 || ttlMs > 30000 || !Number.isFinite(renewMs) || renewMs <= 0 || renewMs >= ttlMs) throw new Error('invalid-operator-lease-timing');
  let context;
  const stop = () => { if (context) clearInterval(context.timer); context = undefined; };
  const checkBinding = (h, c) => {
    if (h.phase !== 'fenced' || h.owner !== c.expected.expectedOwner || h.epoch !== c.expected.expectedEpoch
      || h.operationId !== c.expected.operationId || h.fence !== c.expected.fence || h.operatorLease?.id !== c.claim.id
      || h.operatorLeaseStatus?.ended) throw new Error('operator-lease-fence-unconfirmed');
  };
  const assertHealthy = () => { if (context && (context.failure || performance.now() >= context.deadline)) throw new Error('operator-lease-renewal-failed'); };
  return {
    async acquireFence(input) {
      if (context) throw new Error('operator-lease-already-owned');
      const before = await rpc(), h = before.handoff;
      if (h.operatorLeaseProtocolVersion !== 1) return rpc('fence', input);
      if (h.phase !== 'open' || h.owner !== input.expectedOwner || h.epoch !== input.expectedEpoch) throw new Error('operator-lease-source-changed');
      const claim = await operatorLeaseClaim(ttlMs);
      const c = { claim, expected: { expectedOwner: h.owner, expectedEpoch: h.epoch + 1,
        operationId: input.operationId, fence: input.fence,
        ...(input.historicalUnknownSha256 === undefined ? {} : { historicalUnknownSha256: input.historicalUnknownSha256 }), operatorLease: claim },
        deadline: performance.now() + ttlMs, acquiring: true, acknowledged: false, renewing: false, failure: false, timer: undefined };
      context = c;
      const renew = async () => {
        const before = performance.now();
        const value = await rpc('renew-operator-lease', c.expected);
        checkBinding(value.handoff, c); c.deadline = before + ttlMs;
        if (performance.now() >= c.deadline) throw new Error('operator-lease-renewal-response-expired');
        c.acknowledged = true;
      };
      // Fence persists its binding before potentially slow quiescence finishes.
      // Renew that exact next epoch independently of the original HTTP response.
      c.timer = setInterval(() => {
        if (context !== c || c.renewing) return;
        c.renewing = true;
        void renew().catch(() => {
          // An early request can precede the fence commit. Once acknowledged,
          // loss is terminal for this acquisition, never a new fence or replay.
          if (context === c && (!c.acquiring || c.acknowledged)) { c.failure = true; clearInterval(c.timer); }
        }).finally(() => { c.renewing = false; });
      }, renewMs); c.timer.unref();
      try {
        const result = await rpc('fence', { ...input, operatorLease: claim });
        checkBinding(result.handoff, c); await renew(); c.acquiring = false; assertHealthy();
        return result;
      } catch (error) { stop(); throw error; }
    },
    async abortFence(input) { const result = await rpc('abort', input); stop(); return result; },
    async releaseWriter(input) { assertHealthy(); const result = await rpc('release', input); stop(); return result; },
    assertHealthy,
    dispose: stop,
  };
}
