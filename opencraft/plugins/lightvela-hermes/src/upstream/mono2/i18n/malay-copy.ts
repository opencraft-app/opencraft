// @ts-nocheck -- mechanically vendored from mono2; typechecked in its source repository.
let copy: Readonly<Record<string, string>> | undefined;
let pending: Promise<void> | undefined;

/** Load the large public catalog only when Malay is requested. Failed loads may be retried. */
export function ensureMalayPublicCopy(): Promise<void> {
  if (copy) return Promise.resolve();
  if (!pending) {
    pending = import('./generated/malay-public-copy.json').then((module) => {
      copy = module.default;
    }).finally(() => { pending = undefined; });
  }
  return pending;
}
const identifiers = new Set(['id', 'key', 'type', 'kind', 'fieldKey', 'rawId', 'slug', 'registry', 'href', 'url', 'src']);

function translateText(value: string): string {
  const catalog = copy;
  if (!catalog) throw new Error("Malay public copy must be loaded before rendering");
  const translated = Object.hasOwn(catalog, value) ? catalog[value] : undefined;
  if (translated !== undefined) return translated;
  return value.split('\n').map((line) => Object.hasOwn(catalog, line) ? catalog[line] ?? line : line).join('\n');
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
