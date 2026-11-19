export interface ConversationFailureSummary {
  transportStage: string;
  rpcCode: number | null;
  status: number | null;
  reason: string;
}
export function conversationFailure(
  error: unknown,
  stage?: string,
  engineMessage?: unknown,
): ConversationFailureSummary;
export class ConversationFailureDiagnostics {
  constructor(now?: () => number, emit?: (record: Readonly<Record<string, unknown>>) => void);
  report(requestId: string, binding: { hostId: string; threadId: string }, phase: string, error: unknown): void;
}
