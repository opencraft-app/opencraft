export const THREAD_ACCESS_READ = 'opencraft/thread-access/read';
export const THREAD_ACCESS_SET = 'opencraft/thread-access/set';
export const THREAD_ACCESS_CHANGED = 'opencraft/thread-access/changed';
export const THREAD_ACCESS_REVOKED = 'opencraft/thread-access/revoked';
export interface ThreadAccessSnapshot {
  serverId: string;
  threadId: string;
  creatorActorId: string | null;
  accessMode: 'shared' | 'private';
  revision: number;
  canChangeAccess: boolean;
}
export interface ThreadAccessMethodMap {
  'opencraft/thread-access/read': {params: {threadId: string}; result: ThreadAccessSnapshot};
  'opencraft/thread-access/set': {params: {threadId: string; accessMode: 'shared' | 'private'; expectedRevision: number}; result: ThreadAccessSnapshot};
}
