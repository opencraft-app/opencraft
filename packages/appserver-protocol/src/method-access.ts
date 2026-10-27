/** Bridge admission, not a claim that the upstream implements every method. */
export const OPENCRAFT_METHOD_ACCESS_EXTENSION = "opencraft/method-access";

export interface AppServerMethodAccess {
  readonly version: 1;
  readonly methods: readonly string[];
}

export function parseAppServerMethodAccess(value: unknown): AppServerMethodAccess | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.version !== 1 || !Array.isArray(candidate.methods)
    || candidate.methods.length > 512
    || candidate.methods.some(method => typeof method !== "string" || !method || method.length > 128)) return null;
  return { version: 1, methods: [...new Set(candidate.methods as string[])] };
}

/** Legacy Servers have no admission manifest; malformed manifests fail closed. */
export function allowsAppServerMethod(
  extensions: Readonly<Record<string, unknown>> | null | undefined,
  method: string,
): boolean {
  const value = extensions?.[OPENCRAFT_METHOD_ACCESS_EXTENSION];
  return value === undefined || parseAppServerMethodAccess(value)?.methods.includes(method) === true;
}
