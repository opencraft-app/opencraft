import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { OperatorLease, type OperatorLeaseClaim } from '../apps/codex-core/src/operator-lease.js';

interface State {
  version: 1; owner: string; epoch: number; phase: 'open' | 'fenced' | 'released' | 'cold-ready';
  operationId?: string; fence?: string; operatorLease?: OperatorLeaseClaim;
  pending: Array<{ id: string; kind: string; startedAt: string }>;
  history: unknown[]; leaseAborts: string[];
}
/** The ledger contains responsibility metadata, never keys, signatures or credentials.
 * The service supervisor holds a separate exclusive flock for this ledger. */
export class GitBrokerOwner {
  private state: State;
  private lease?: OperatorLease;
  private failed = false;
  constructor(private path?: string) {
    const previous: State | undefined = path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : undefined;
    if (previous && (previous.version !== 1 || !Array.isArray(previous.pending) || !Array.isArray(previous.history))) throw Error('Invalid broker ledger');
    if (previous && previous.phase !== 'released' && (previous.phase !== 'open' || previous.pending.length)) throw Error('Broker recovery required');
    this.state = previous ? { ...previous, owner: randomUUID(), phase: previous.phase === 'released' ? 'released' : 'open' }
      : { version: 1, owner: randomUUID(), epoch: 0, phase: 'open', pending: [], history: [], leaseAborts: [] };
    this.save();
  }
  private save() {
    if (!this.path) return;
    try { this.writeState(); } catch (error) { this.failed = true; throw error; }
  }
  private writeState() {
    if (!this.path) return;
    const tmp = this.path + '.' + randomUUID();
    const fd = openSync(tmp, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(this.state) + '\n'); fsyncSync(fd); } finally { closeSync(fd); }
    try {
      renameSync(tmp, this.path);
      const dir = openSync(dirname(this.path), 'r'); try { fsyncSync(dir); } finally { closeSync(dir); }
    } catch (error) { this.failed = true; throw error; }
  }
  snapshot() { return structuredClone({ ...this.state, operatorLeaseStatus: this.lease?.status(), persistence: this.failed ? 'failed' : 'ready' }); }
  admits() { return !this.failed && this.state.phase === 'open'; }
  begin(kind: string, continuation = false) {
    if (this.failed || !(this.state.phase === 'open' || continuation && this.state.phase === 'fenced')) throw Error('Broker admission closed');
    const record = { id: randomUUID(), kind, startedAt: new Date().toISOString() };
    this.state.pending.push(record); this.save();
    return (uncertain = false) => {
      if (uncertain) this.state.history.push({ ...record, outcome: 'unknown', observedAt: new Date().toISOString() });
      this.state.pending = this.state.pending.filter(r => r.id !== record.id); this.save();
    };
  }
  control(input: Record<string, any>, sessions: number, peerPid: number) {
    const s = this.state;
    if (input.action === 'snapshot') return this.snapshot();
    if (input.expectedOwner !== s.owner || input.expectedEpoch !== s.epoch) throw Error('Broker owner changed');
    if (input.action === 'fence') {
      if (s.phase !== 'open' || !/^[a-zA-Z0-9._-]{1,128}$/.test(input.operationId ?? '') || !/^[a-zA-Z0-9._-]{1,128}$/.test(input.fence ?? '')
        || input.operatorLease?.controller?.pid !== peerPid) throw Error('Invalid broker fence');
      const lease = new OperatorLease(input.operatorLease, s.leaseAborts);
      s.epoch++; s.phase = 'fenced'; s.operationId = input.operationId; s.fence = input.fence; s.operatorLease = lease.claim; this.save();
      this.lease = lease;
      lease.start(reason => {
        s.history.push({ kind: 'operator-lease-abort', operationId: s.operationId, fence: s.fence, reason, observedAt: new Date().toISOString() });
        s.leaseAborts.push(lease.claim.id); s.phase = 'open'; delete s.operatorLease; this.save(); lease.dispose(); this.lease = undefined;
      }, () => { this.failed = true; });
      return this.snapshot();
    }
    if (input.operationId !== s.operationId || input.fence !== s.fence) throw Error('Broker fence changed');
    if (input.action === 'renew-operator-lease') { this.lease?.renew(input.operatorLease); if (!this.lease) throw Error('No broker lease'); return this.snapshot(); }
    if (input.action === 'abort' && s.phase === 'fenced') { s.phase = 'open'; this.lease?.dispose(); this.lease = undefined; delete s.operatorLease; this.save(); return this.snapshot(); }
    if (input.action === 'release' && s.phase === 'fenced') {
      this.lease?.assertLive();
      if (!this.lease || sessions || s.pending.length) throw Error('Broker responsibilities remain');
      s.phase = 'released'; delete s.operatorLease; this.save(); this.lease.dispose(); this.lease = undefined; return this.snapshot();
    }
    if (input.action === 'cold-ready' && s.phase === 'released' && !sessions && !s.pending.length) { s.phase = 'cold-ready'; this.save(); return this.snapshot(); }
    if (input.action === 'resume' && s.phase === 'cold-ready') { s.phase = 'open'; this.save(); return this.snapshot(); }
    throw Error('Invalid broker transition');
  }
  close() { this.lease?.dispose(); }
}
