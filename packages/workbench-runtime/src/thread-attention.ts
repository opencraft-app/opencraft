/** Read receipts are Turn identities, independent of execution and selection.
 * A receipt for an old Turn can never acknowledge a newer result. */
export class ThreadAttention {
  private readonly results = new Map<string, string>();
  private readonly read = new Set<string>();
  private revision = 0;
  private readonly listeners = new Set<() => void>();
  constructor(readReceipts: readonly string[] = []) {
    for (const key of readReceipts.slice(-4096)) this.read.add(key);
  }
  private key(hostId: string, threadId: string) { return JSON.stringify([hostId, threadId]); }
  private receipt(hostId: string, threadId: string, turnId: string) { return JSON.stringify([hostId, threadId, turnId]); }
  getSnapshot = () => this.revision;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish() { ++this.revision; for (const listener of this.listeners) listener(); }
  observe(hostId: string, threadId: string, turnId: string) {
    const key = this.key(hostId, threadId);
    if (this.results.get(key) === turnId) return;
    this.results.delete(key);
    this.results.set(key, turnId);
    if (this.results.size > 2048) this.results.delete(this.results.keys().next().value!);
    this.publish();
  }
  acknowledge(hostId: string, threadId: string, turnId: string) {
    const receipt = this.receipt(hostId, threadId, turnId);
    if (this.read.has(receipt)) return false;
    this.read.add(receipt);
    if (this.read.size > 4096) this.read.delete(this.read.values().next().value!);
    this.publish();
    return true;
  }
  unread(hostId: string, threadId: string) {
    const turnId = this.results.get(this.key(hostId, threadId));
    return turnId !== undefined && !this.read.has(this.receipt(hostId, threadId, turnId));
  }
  mergeReceipts(receipts: readonly string[]) {
    let changed = false;
    for (const receipt of receipts) if (!this.read.has(receipt)) { this.read.add(receipt); changed = true; }
    while (this.read.size > 4096) this.read.delete(this.read.values().next().value!);
    if (changed) this.publish();
  }
  receipts() { return [...this.read]; }
}
