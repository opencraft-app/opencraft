// Declarative evaluation: pure, synchronous and runtime-neutral.
import { normalizeValue, type LoginAdmissionMatch, type LoginAdmissionRules } from "./contract";

/** The verified facts a decision is made from: never a credential. */
export interface LoginAdmissionIdentity {
  readonly provider: string;
  readonly subject: string;
  readonly attributes: Readonly<Record<string, string>>;
}

export interface CompiledRules {
  readonly rules: LoginAdmissionRules;
  /** First declarative rule that admits the identity, or null. */
  match(identity: LoginAdmissionIdentity, attribute: string): LoginAdmissionMatch | null;
}

/**
 * Anchored glob match in O(value * pattern) without backtracking blowup:
 * `*` matches any run and `?` one character; everything else is literal.
 */
export function globMatches(pattern: readonly string[], value: readonly string[]): boolean {
  let p = 0,
    v = 0,
    star = -1,
    resume = 0;
  while (v < value.length) {
    if (p < pattern.length && (pattern[p] === "?" || (pattern[p] !== "*" && pattern[p] === value[v]))) {
      p++;
      v++;
    } else if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      resume = v;
    } else if (star !== -1) {
      p = star + 1;
      v = ++resume;
    } else return false;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

export function compileRules(rules: LoginAdmissionRules): CompiledRules {
  const allowlist = new Set(rules.allowlist.map(normalizeValue));
  const patterns = rules.patterns.map((pattern) => [...normalizeValue(pattern)]);
  const conditions = rules.conditions.map((condition) => ({
    attribute: condition.attribute,
    equals: normalizeValue(condition.equals),
  }));
  return {
    rules,
    match(identity, attribute) {
      const login = Object.hasOwn(identity.attributes, attribute) ? identity.attributes[attribute] : undefined;
      if (login !== undefined) {
        const normalized = normalizeValue(login),
          characters = [...normalized];
        if (allowlist.has(normalized)) return "allowlist";
        if (patterns.some((pattern) => globMatches(pattern, characters))) return "pattern";
      }
      if (
        conditions.some(
          (condition) =>
            Object.hasOwn(identity.attributes, condition.attribute) &&
            normalizeValue(identity.attributes[condition.attribute]!) === condition.equals,
        )
      )
        return "condition";
      return null;
    },
  };
}

/** Default JSON input of `admit(input)`. A composition may supply its own mapping. */
export interface LoginAdmissionFunctionInput {
  readonly identity: {
    readonly provider: string;
    readonly subject: string;
    /** Value of the scope's login attribute. */
    readonly value: string;
    readonly attributes: Readonly<Record<string, string>>;
  };
}

export const defaultFunctionInput =
  (attribute: string) =>
  (identity: LoginAdmissionIdentity): LoginAdmissionFunctionInput => ({
    identity: {
      provider: identity.provider,
      subject: identity.subject,
      value: identity.attributes[attribute] ?? "",
      attributes: { ...identity.attributes },
    },
  });

/** Canonical key of the verified attributes a decision was made from. */
export function attributesKey(attributes: Readonly<Record<string, string>>): string {
  return JSON.stringify(
    Object.keys(attributes)
      .sort()
      .map((key) => [key, attributes[key]]),
  );
}
