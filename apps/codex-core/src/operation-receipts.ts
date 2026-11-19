/** Agent-owned receipts. A transport subscriber never owns the operation. */
export type OperationReply = {result?: unknown; error?: unknown};
type Subscriber = {owner: object; id: unknown; deliver: (reply: OperationReply) => void};
type Receipt = {publication: boolean; settled: boolean;fingerprint: string; reply?: OperationReply; subscribers: Subscriber[]};
export class OperationReceipts {
  private readonly records = new Map<string, Receipt>();
  constructor(private readonly limit = 1024, private readonly subscriberLimit = 32) {}
  get(key: string): Readonly<Receipt> | undefined { return this.records.get(key); }
  get size(): number { return this.records.size; }
  subscribe(key: string, fingerprint: string, subscriber: Subscriber, publication = false): 'created' | 'existing' {
    const prior = this.records.get(key);
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new Error('Orchestration operation reused');
      if (prior.reply) subscriber.deliver(prior.reply);
      else if (!prior.subscribers.some(value => value.owner === subscriber.owner && value.id === subscriber.id)) {
        if (prior.subscribers.length >= this.subscriberLimit) throw new Error('Operation subscriber limit');
        prior.subscribers.push(subscriber);
      }
      return 'existing';
    }
    if (this.records.size >= this.limit) throw new Error('Unacknowledged orchestration receipt limit');
    this.records.set(key, {fingerprint, publication, settled:false, subscribers: [subscriber]});
    return 'created';
  }
  complete(key: string, reply: OperationReply): void {
    const record = this.records.get(key);
    if (!record || record.settled) return;
    record.settled = true;
    record.reply = reply;
    for (const subscriber of record.subscribers) subscriber.deliver(reply);
    record.subscribers = [];
  }
  uncertain(key: string, reply: OperationReply): void {
    const record = this.records.get(key);
    if (!record || record.settled) return;
    record.reply = reply;
    for (const subscriber of record.subscribers) subscriber.deliver(reply);
    record.subscribers = [];
  }
  detach(owner: object): void {
    for (const record of this.records.values()) record.subscribers = record.subscribers.filter(value => value.owner !== owner);
  }
  acknowledge(key: string): boolean {
    const record = this.records.get(key);
    if (record && !record.settled) return false;
    this.records.delete(key);
    return true;
  }
  clear(): void { this.records.clear(); }
}
