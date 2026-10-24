/** Provider-scoped subjects are immutable identity bindings, never display names. */
export interface Principal {
  readonly provider: string;
  readonly subject: string;
  readonly displayName: string;
  readonly expiresAt: number;
  readonly attributes?: Readonly<Record<string, string>>;
  readonly aliases?: readonly string[];
}
export function parsePrincipal(input: unknown): Principal {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid principal");
  const p = input as Record<string, unknown>;
  if (typeof p.provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/u.test(p.provider)
    || typeof p.subject !== "string" || !/^[A-Za-z0-9:@._-]{1,256}$/u.test(p.subject)
    || typeof p.displayName !== "string" || p.displayName.length < 1 || p.displayName.length > 256
    || typeof p.expiresAt !== "number" || !Number.isSafeInteger(p.expiresAt)) throw new Error("Invalid principal");
  const attributes: Record<string, string> = {};
  if (p.attributes !== undefined) {
    if (!p.attributes || typeof p.attributes !== "object" || Array.isArray(p.attributes) || Object.keys(p.attributes).length > 16) throw new Error("Invalid principal attributes");
    for (const [key, value] of Object.entries(p.attributes)) {
      if (!/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u.test(key) || typeof value !== "string" || value.length > 256) throw new Error("Invalid principal attributes");
      attributes[key] = value;
    }
  }
  if (p.aliases !== undefined && (!Array.isArray(p.aliases) || p.aliases.length > 8 || !p.aliases.every(a => typeof a === 'string' && /^[A-Za-z0-9:@._-]{1,256}$/u.test(a)))) throw new Error('Invalid principal aliases');
  return Object.freeze({ provider: p.provider, subject: p.subject, displayName: p.displayName,
    expiresAt: p.expiresAt, attributes: Object.freeze(attributes), aliases: Object.freeze([...(p.aliases as string[] | undefined ?? [])]) });
}
export function principalKey(p: Pick<Principal, "provider" | "subject">): string { return JSON.stringify([p.provider, p.subject]); }
