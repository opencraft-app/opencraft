import type { DuplexTransport, TransportSubmissionContext } from '@opencraft/appserver-client/transport';
import { LOGICAL_CLIENT_FIELD } from '@opencraft/app-host-protocol';

type Lifecycle = {
  invalidateHost?(hostId: string): void;
  assertActive(hostId: string, threadId: string): void;
  observe(hostId: string, threadId: string, state: 'active' | 'archived' | 'deleted'): Promise<void>;
};
const transitions: Record<string, 'active' | 'archived' | 'deleted'> = {
  'thread/archive': 'archived', 'thread/archived': 'archived',
  'thread/delete': 'deleted', 'thread/deleted': 'deleted',
  'thread/unarchive': 'active', 'thread/unarchived': 'active',
};
const allocating = new Set(['process/spawn', 'turn/start', 'turn/steer', 'thread/queue/add', 'thread/queue/start']);
const requestKey = (value: any) => JSON.stringify([value[LOGICAL_CLIENT_FIELD] ?? null, value.id]);
/** Observes the trusted engine lane, including while no renderer is attached.
 * Failed RPCs never retire resources. Correlation includes logical client ID. */
export class ConversationResourceTransport implements DuplexTransport {
  private readonly pending = new Map<string, { threadId: string; state: 'active' | 'archived' | 'deleted'; observed?: boolean }>();
  private readonly listeners = new Set<(frame: string) => void>();
  private readonly remove: () => void;
  private readonly removeStatus: () => void;
  private poisoned = false;
  constructor(private readonly inner: DuplexTransport, private readonly hostId: string, private readonly lifecycle: Lifecycle) {
    this.removeStatus = inner.subscribeStatus(status => {
      if (status.state === 'closed' || status.state === 'failed') {
        this.pending.clear(); lifecycle.invalidateHost?.(hostId);
      }
    });
    this.remove = inner.subscribeMessage(frame => {
      const value = JSON.parse(frame);
      const pending = value.id != null ? this.pending.get(requestKey(value)) : undefined;
      if (pending) this.pending.delete(requestKey(value));
      const state = pending && !pending.observed && Object.hasOwn(value, 'result') ? pending.state
        : value.id == null ? transitions[value.method] : undefined;
      const threadId = pending?.threadId ?? value.params?.threadId;
      if (state && typeof threadId === 'string') {
        if (value.id == null) for (const entry of this.pending.values())
          if (entry.threadId === threadId && entry.state === state) entry.observed = true;
        try { void lifecycle.observe(hostId, threadId, state).catch(() => { this.poisoned = true; }); }
        catch { this.poisoned = true; }
      }
      for (const listener of this.listeners) listener(frame);
    });
  }
  get status() { return this.inner.status; }
  connect(signal?: AbortSignal) { return this.inner.connect(signal); }
  captureMessageScope() { return this.inner.captureMessageScope?.() ?? (() => this.inner.status.state === 'open'); }
  subscribeMessage(listener: (frame: string) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  subscribeStatus: DuplexTransport['subscribeStatus'] = listener => this.inner.subscribeStatus(listener);
  subscribeRecoveryHint: NonNullable<DuplexTransport['subscribeRecoveryHint']> = listener => this.inner.subscribeRecoveryHint?.(listener) ?? (() => {});
  send(frame: string, signal?: AbortSignal) { return this.sendWithContext(frame, { sender: null }, signal); }
  async sendWithContext(frame: string, context: TransportSubmissionContext, signal?: AbortSignal) {
    const value = JSON.parse(frame), threadId = value.params?.threadId;
    if (allocating.has(value.method)) {
      if (this.poisoned) throw Error('Conversation resource journal unavailable');
      if (typeof threadId === 'string') this.lifecycle.assertActive(this.hostId, threadId);
    }
    const key = requestKey(value);
    if (value.id != null && transitions[value.method] && typeof threadId === 'string') {
      if (this.pending.size >= 1024) throw Error('Too many pending lifecycle operations');
      this.pending.set(key, { threadId, state: transitions[value.method]! });
    }
    try {
      if (this.inner.sendWithContext) await this.inner.sendWithContext(frame, context, signal);
      else await this.inner.send(frame, signal);
    } catch (error) { this.pending.delete(key); throw error; }
  }
  async close() { this.removeStatus(); this.remove(); this.pending.clear(); this.listeners.clear(); await this.inner.close(); }
}
