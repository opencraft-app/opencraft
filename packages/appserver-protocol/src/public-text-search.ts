/** Imported display history only; never Native search or an aggregate count. */
export const PUBLIC_TEXT_SEARCH_CAPABILITY = 'opencraft/public-text-search';
export const PUBLIC_TEXT_SEARCH_METHOD = 'opencraft/history/public-text-search';
export const PUBLIC_TEXT_SEARCH_MODE = 'public-text-token-and-v1';
export function publicTextQuery(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || [...value].length > 512) throw new Error('Invalid text query');
  const query = value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().trim();
  if (!/[\p{L}\p{N}]/u.test(query)) throw new Error('Text query needs letters or numbers');
  return query;
}
export interface PublicTextFence { lifetime: string; revision: number; upper: number; position: number }
export type PublicTextRead = { kind: 'window'; cursor: PublicTextFence | null } |
  { kind: 'project'; cursor: PublicTextFence; query: string; positions: number[] } |
  { kind: 'validate'; cursor: PublicTextFence };
export interface PublicTextItem { position: number; threadId: string; turnId: string; itemId: string; role: 'user' | 'assistant'; snippet: string }
export interface PublicTextWindow {
  fence: PublicTextFence; observedAt: number;
  candidates: { position: number; threadId: string }[];
  entries: PublicTextItem[];
}
/** Shared cooperative cancellation. No SQLite hard-interrupt guarantee. */
export interface PublicTextControl { deadline: number; cancellation?: Int32Array }
export interface ConversationTextSearch {
  serverId: string; field: 'text'; mode: typeof PUBLIC_TEXT_SEARCH_MODE;
  scope: 'authorized-imported-public-text'; source: 'server-conversation-history';
  coverage: 'indexed-recorded-only'; consistency: 'revision-bound'; observedAt: number;
  entries: (Omit<PublicTextItem, 'position' | 'threadId'> & {ref: import('./collaboration').ConversationRef})[];
  nextCursor: string | null; traversalComplete: boolean;
  count: { status: 'unknown'; value: null; unit: 'items' };
}
