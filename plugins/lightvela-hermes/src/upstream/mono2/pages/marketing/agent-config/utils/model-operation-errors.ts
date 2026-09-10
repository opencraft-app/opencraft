// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
const MODEL_SWITCH_CANCELLED_PATTERNS = [
  /已取消模型切换/,
  /\bmodel\s+switch\s+cancell?ed\b/i,
  /\bcancell?ed\s+model\s+switch\b/i,
];

const MODEL_UNAVAILABLE_PATTERNS = [/the requested model is not available in your current plan/i];

export function getErrorMessageText(error: unknown): string {
  if (error instanceof Error) return error.message.trim();
  if (typeof error === 'string') return error.trim();
  return '';
}

export function isModelSwitchCancelledMessage(message?: string | null): boolean {
  const text = (message || '').trim();
  if (!text) return false;
  return MODEL_SWITCH_CANCELLED_PATTERNS.some((pattern) => pattern.test(text));
}

export function isModelUnavailableMessage(message?: string | null): boolean {
  const text = (message || '').trim();
  if (!text) return false;
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(text));
}

export function getKnownSafeExecutorErrorOutput(error: unknown): string {
  const message = getErrorMessageText(error);
  if (isModelSwitchCancelledMessage(message)) return message;
  return '';
}

export function getModelSwitchFailureMessage(
  raw: string | null | undefined,
  fallback: string,
  modelUnavailableMessage: string,
): string {
  const message = (raw || '').trim();
  if (isModelSwitchCancelledMessage(message)) return '';
  if (isModelUnavailableMessage(message)) return modelUnavailableMessage;
  return message || fallback;
}
