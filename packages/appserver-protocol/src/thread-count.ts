/** Counts only the complete, bounded registered set under one stable authorization interval. */
export const THREAD_COUNT_CAPABILITY = 'opencraft/recorded-thread-count';
export const THREAD_COUNT_METHOD = 'opencraft/thread-directory/count-set';
export const THREAD_COUNT_MODE = 'authorized-recorded-threads-v1';
export type RecordedThreadCountRead = {kind:'capture'} | {kind:'validate';ticket:string};
export type RecordedThreadCountSet = {status:'unknown'} | {
  status:'complete'; ids:string[]; ticket:string; observedAt:number;
} | {status:'validated'};
export interface ConversationThreadCount {
  instanceId:string; serverId:string;
  unit:'threads'; scope:'authorized-recorded-threads'; source:'host-thread-directory';
  coverage:'recorded-only'; archived:false; consistency:'authorized-stable-window';
  observedAt:number; status:'exact'|'unknown'; value:number|null;
}
