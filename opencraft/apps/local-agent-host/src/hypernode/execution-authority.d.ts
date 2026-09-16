export class ThreadExecutionTable {
  constructor(options?: any);
  claim(...args: any[]): any;
  bindTurn(...args: any[]): any;
  bindRuntime(...args: any[]): any;
  markNativeStarted(...args: any[]): any;
  finish(...args: any[]): any;
  get(threadId: string): any;
  values(): Iterable<any>;
  seedEpoch(threadId: string, epoch: number): number | null;
  latestEpoch(threadId: string): number | null;
}
export class ThreadExecutionJournal {
  constructor(storage: any, options?: any);
  loadEpochs(): Array<{ threadId: string; epoch: number }>;
  fencePreviousBoot(): any[];
  recoverableOrphans(): any[];
  claim(execution: any): void;
  update(execution: any, state?: string): void;
  terminal(execution: any, state: string, reason: string): void;
  nativeHistory(threadId: string): { available: boolean; attempts: number; nativeStarts: number };
}
