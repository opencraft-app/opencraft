export type OpaqueId<TName extends string> = string & { readonly __opaqueId: TName };

export type HostId = OpaqueId<"HostId">;
export type ThreadId = OpaqueId<"ThreadId">;
export type TurnId = OpaqueId<"TurnId">;
export type ItemId = OpaqueId<"ItemId">;
export type CallId = OpaqueId<"CallId">;
export type ClientMessageId = OpaqueId<"ClientMessageId">;
export type CommandId = OpaqueId<"CommandId">;

export interface ConversationKey {
  readonly hostId: HostId;
  readonly threadId: ThreadId;
}

function requireId<TName extends string>(value: string, name: TName): OpaqueId<TName> {
  if (value.length === 0) throw new RangeError(`${name} must not be empty`);
  return value as OpaqueId<TName>;
}

export const asHostId = (value: string): HostId => requireId(value, "HostId");
export const asThreadId = (value: string): ThreadId => requireId(value, "ThreadId");
export const asTurnId = (value: string): TurnId => requireId(value, "TurnId");
export const asItemId = (value: string): ItemId => requireId(value, "ItemId");
export const asCallId = (value: string): CallId => requireId(value, "CallId");
export const asClientMessageId = (value: string): ClientMessageId => requireId(value, "ClientMessageId");
export const asCommandId = (value: string): CommandId => requireId(value, "CommandId");

export function createConversationKey(hostId: string, threadId: string): ConversationKey {
  return Object.freeze({ hostId: asHostId(hostId), threadId: asThreadId(threadId) });
}

export function equalConversationKey(left: ConversationKey, right: ConversationKey): boolean {
  return left.hostId === right.hostId && left.threadId === right.threadId;
}

/** Collision-free internal key; neither Host nor Thread IDs are constrained by a delimiter. */
export function encodeConversationKey(key: ConversationKey): string {
  return JSON.stringify([key.hostId, key.threadId]);
}
