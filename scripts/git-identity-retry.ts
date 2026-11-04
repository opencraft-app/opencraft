import { randomUUID } from 'node:crypto';
import { queryGitIdentityBroker, GitIdentityTransportError } from './git-identity-ipc.js';

// Only protocol-owned codes may reach stderr; never echo an arbitrary error or reply.
export const gitIdentityReasons = ['origin-unresolved', 'lease-unresolved', 'live-inspection-unavailable',
  'lease-changed', 'execution-expired', 'invalid-request', 'peer-mismatch', 'broker-error',
  'ipc-timeout', 'ipc-disconnected', 'ipc-connect-failed', 'ipc-invalid-response', 'broker-unavailable'] as const;
export type GitIdentityReason = typeof gitIdentityReasons[number];
export function gitIdentityReason(value: unknown): GitIdentityReason {
  return gitIdentityReasons.includes(value as GitIdentityReason) ? value as GitIdentityReason : 'broker-unavailable';
}
/** Retry only authorization lookup. No native Git command is run or replayed here. */
export async function retryGitIdentity(socket: string, request: Record<string, unknown>, options: {
  budgetMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void>;
  query?: typeof queryGitIdentityBroker;
} = {}) {
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const query = options.query ?? queryGitIdentityBroker;
  const started = now(), deadline = started + (options.budgetMs ?? 15_000), requestId = randomUUID();
  let reason: GitIdentityReason = 'broker-unavailable', attempts = 0;
  while (now() < deadline) {
    if (attempts) await sleep(Math.min(100 * 2 ** Math.min(attempts - 1, 4), Math.max(0, deadline - now())));
    if (now() >= deadline) break;
    attempts++;
    let expired = false;
    try {
      const answer = await query(socket, { ...request, requestId }, Math.min(2_000, deadline - now()));
      if (answer.status === 'expired') { expired = true; reason = 'execution-expired'; }
      else if (answer.status !== 'unavailable') return answer;
      else reason = gitIdentityReason(answer.reason);
    } catch (error) { reason = error instanceof GitIdentityTransportError ? error.reason : 'ipc-connect-failed'; }
    if (expired || ['invalid-request', 'peer-mismatch', 'lease-changed'].includes(reason)) break;
  }
  throw new Error(`Git identity ${reason}; requestId=${requestId}; attempts=${attempts}; elapsedMs=${Math.round(now() - started)}; refusing server-account fallback`);
}
