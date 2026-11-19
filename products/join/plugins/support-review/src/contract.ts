export const SUPPORT_REVIEW_PATH = '/__opencraft_enterprise_identity/support-reviews';
export const REVIEW_INPUT_LIMIT = 1_000_000;
export const REVIEW_OUTPUT_LIMIT = 8_000_000;
export const REVIEW_TIMEOUT_MS = 90_000;
export type ReviewResult = { ok: boolean; result?: unknown; error?: string };
export type ReviewInput = Record<string, unknown> & { action: string; actor: string };
export interface ReviewExecutor {
  execute(input: ReviewInput, current: () => boolean): Promise<ReviewResult | null>;
}
export function reviewAction(value: unknown): value is string {
  return typeof value === 'string' && ['list', 'edit', 'assign', 'approve_send', 'settings'].includes(value);
}
export function reviewInput(value: unknown): value is ReviewInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const input = value as Record<string, unknown>;
  return reviewAction(input.action) && typeof input.actor === 'string'
    && input.actor.length > 0 && input.actor.length <= 256 && !/[\x00-\x1f\x7f]/u.test(input.actor);
}
export function reviewResult(value: unknown): value is ReviewResult {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as ReviewResult).ok === 'boolean'
    && ((value as ReviewResult).error === undefined || typeof (value as ReviewResult).error === 'string');
}
