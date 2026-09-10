// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
/** Normalize whitespace characters commonly introduced when JSON is pasted from rich text. */
export function parseJsonWithNormalizedWhitespace<T>(value: string): T {
  return JSON.parse(value.replace(/[\u00a0\u2007\u202f]/g, ' ')) as T;
}
