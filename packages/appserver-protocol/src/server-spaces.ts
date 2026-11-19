/** Collaboration space identity is independent of an engine Server or Host. */
export const SERVER_SPACES_METHOD = 'opencraft/server-spaces';
export const SERVER_SPACES_CHANGED = 'opencraft/server-spaces/changed';
export const DEFAULT_SERVER_SPACE = 'myself';
export interface ServerSpace {
  id: string; name: string; role: 'owner' | 'member'; memberCount: number;
}
export interface ServerSpaceMember { actorId: string; displayName: string; role: 'owner' | 'member' }
export interface ServerSpaceDirectory {
  spaces: ServerSpace[];
  assignments: {engineServerId: string; threadId: string; spaceId: string}[];
  actorId: string;
}
export type ServerSpaceCommand =
  | { action: 'list' }
  | { action: 'create'; name: string }
  | { action: 'select'; spaceId: string }
  | { action: 'members'; spaceId: string }
  | { action: 'invite'; spaceId: string }
  | { action: 'join'; code: string }
  | { action: 'remove'; spaceId: string; actorId: string };
