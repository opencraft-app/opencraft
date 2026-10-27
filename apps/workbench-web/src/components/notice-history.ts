export type NoticeTone = "info" | "success" | "warning" | "error";
export interface OperationNotice {
  /** Stable operation/entity key; repeat occurrences update the same record. */
  readonly key: string;
  /** Localized, user-safe copy. Never pass raw RPC errors. */
  readonly message: string;
  readonly detail?: string;
}
export interface NoticeRecord extends OperationNotice {
  readonly tone: NoticeTone;
  readonly receivedAt: number;
  readonly occurrences: number;
  readonly read: boolean;
}
export type NoticeHistoryAction =
  | { readonly type: "publish"; readonly notice: OperationNotice; readonly tone: NoticeTone; readonly now: number }
  | { readonly type: "read" }
  | { readonly type: "clear" };

/** Presentation history only, never a durable task inbox or execution authority. */
export function reduceNoticeHistory(history: readonly NoticeRecord[], action: NoticeHistoryAction): readonly NoticeRecord[] {
  if (action.type === "clear") return [];
  if (action.type === "read") return history.map(record => record.read ? record : { ...record, read: true });
  const previous = history.find(record => record.key === action.notice.key);
  const record: NoticeRecord = { ...action.notice, tone: action.tone, receivedAt: action.now,
    occurrences: (previous?.occurrences ?? 0) + 1, read: false };
  return [record, ...history.filter(item => item.key !== record.key)].slice(0, 50);
}
