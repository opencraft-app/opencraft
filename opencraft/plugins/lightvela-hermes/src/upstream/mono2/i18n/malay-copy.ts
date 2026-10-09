// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
import translations from './generated/malay-public-copy.json';

const copy: Readonly<Record<string, string>> = translations;
const identifiers = new Set(['id', 'key', 'type', 'kind', 'fieldKey', 'rawId', 'slug', 'registry', 'href', 'url', 'src']);

function translateText(value: string): string {
  const translated = Object.hasOwn(copy, value) ? copy[value] : undefined;
  if (translated !== undefined) return translated;
  return value.split('\n').map((line) => Object.hasOwn(copy, line) ? copy[line] ?? line : line).join('\n');
}

/** Translate the public site's structured English copy without changing keys or identifiers. */
export function localizeMalay<T>(value: T): T {
  if (typeof value === 'string') {
    return translateText(value) as T;
  }
  if (Array.isArray(value)) return value.map((item: unknown) => localizeMalay(item)) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]: [string, unknown]) => [key, identifiers.has(key) ? item : localizeMalay(item)]),
    ) as T;
  }
  return value;
}
