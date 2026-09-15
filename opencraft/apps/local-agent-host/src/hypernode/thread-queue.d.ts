export class ThreadQueueStore {
  constructor(storage: any, createId?: () => string, now?: () => number);
  add(threadId: string, clientUserMessageId: string, actorUserId: string | null, input: unknown[]): {submission: any;created:boolean};
  find(threadId: string, id: string): any;
  findByClientId(threadId: string, id: string): any;
  pending(threadId: string): any[];
  update(threadId: string, id: string, input: unknown[]): any;
  delete(threadId: string, id: string): boolean;
  markDispatched(threadId: string, id: string): void;
  pauseAfterInterruption(threadId: string): void;
  resume(threadId: string): void;
}
