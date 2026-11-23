// Wire contract shared by the login admission server and its Settings page.
// Runtime-neutral: no Node or DOM imports.

/** Administration route, under the instance access prefix the Hub already authenticates. */
export const LOGIN_ADMISSION_PATH = "/__opencraft_access/login-admission";

export const LOGIN_ADMISSION_LIMITS = Object.freeze({
  allowlist: 10_000,
  patterns: 256,
  conditions: 64,
  value: 256,
  /** UTF-8 bytes of the admin-authored function (the sandbox wrapper needs the rest of 16 KiB). */
  functionBytes: 15_000,
  /** Request body of one publish or preview. */
  body: 512 * 1024,
});

/** One verified attribute equality, e.g. `{ attribute: "department", equals: "research" }`. */
export interface LoginAdmissionCondition {
  readonly attribute: string;
  readonly equals: string;
}

/**
 * The policy document of one `{ provider, attribute }` scope. A login is
 * admitted when the policy is disabled, or when any rule matches: the login
 * attribute is on the allowlist, matches a pattern, a condition holds, or the
 * admin-authored `admit(input)` function returns `{ allow: true }`.
 */
export interface LoginAdmissionRules {
  readonly enabled: boolean;
  /** Exact values of the login attribute, compared case-insensitively. */
  readonly allowlist: readonly string[];
  /** `*` (any run) and `?` (one character) wildcards over the login attribute, case-insensitive. */
  readonly patterns: readonly string[];
  readonly conditions: readonly LoginAdmissionCondition[];
  /** Source declaring `function admit(input)`, run only in the sandbox; null when unused. */
  readonly admitFunction: string | null;
}

export type LoginAdmissionMatch = "allowlist" | "pattern" | "condition" | "function";

export const DISABLED_RULES: LoginAdmissionRules = Object.freeze({
  enabled: false,
  allowlist: Object.freeze([]),
  patterns: Object.freeze([]),
  conditions: Object.freeze([]),
  admitFunction: null,
});

export interface LoginAdmissionScope {
  readonly provider: string;
  readonly attribute: string;
}

export interface LoginAdmissionVersion {
  readonly revision: number;
  readonly rules: LoginAdmissionRules;
  readonly at: number;
}

export interface LoginAdmissionAuditEntry {
  readonly revision: number;
  readonly action: "publish" | "import";
  readonly at: number;
  /** Stable binding of the administrator (or the adoption source operator). */
  readonly operator: string;
}

/** `GET` answer, administrators only. Revision 0 means nothing was published yet. */
export interface LoginAdmissionDocument {
  readonly scope: LoginAdmissionScope;
  readonly revision: number;
  readonly rules: LoginAdmissionRules;
  readonly updatedAt: number | null;
  /** Previously verified logins this policy evaluates for durable work. */
  readonly knownIdentities: number;
  readonly versions: readonly LoginAdmissionVersion[];
  readonly audit: readonly LoginAdmissionAuditEntry[];
}

export interface LoginAdmissionPreviewIdentity {
  /** Value of the scope's login attribute. */
  readonly value: string;
  readonly subject?: string;
  readonly attributes?: Readonly<Record<string, string>>;
}

export type LoginAdmissionRequest =
  | { readonly action: "publish"; readonly revision: number; readonly rules: LoginAdmissionRules }
  | {
      readonly action: "preview";
      readonly rules: LoginAdmissionRules;
      readonly identity: LoginAdmissionPreviewIdentity;
    };

export interface LoginAdmissionPreviewResult {
  readonly allow: boolean;
  readonly match: LoginAdmissionMatch | null;
  /** The function failed or exceeded its limits: the login would be refused. */
  readonly failed: boolean;
}

export const LOGIN_ADMISSION_ERRORS = [
  "administrator_required",
  "same_origin_json_required",
  "revision_conflict",
  "cannot_remove_own_administration",
  "invalid_policy",
  "too_large",
  "policy_unavailable",
] as const;
export type LoginAdmissionError = (typeof LOGIN_ADMISSION_ERRORS)[number];

export class InvalidLoginAdmissionRules extends Error {
  constructor() {
    super("invalid_policy");
    this.name = "InvalidLoginAdmissionRules";
  }
}

const ATTRIBUTE = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/u;
// The same bounds identity-core applies to verified attribute values; no control characters.
const VALUE = /^[^\u0000-\u001f\u007f]{1,256}$/u;

export const isAttributeName = (value: unknown): value is string => typeof value === "string" && ATTRIBUTE.test(value);

/** The comparison form of an attribute value. */
export const normalizeValue = (value: string): string => value.normalize("NFC").toLowerCase();

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new InvalidLoginAdmissionRules();
  return value as Record<string, unknown>;
};
const value = (input: unknown): string => {
  if (typeof input !== "string") throw new InvalidLoginAdmissionRules();
  const trimmed = input.trim();
  if (!VALUE.test(trimmed)) throw new InvalidLoginAdmissionRules();
  return trimmed;
};
const list = (input: unknown, limit: number): unknown[] => {
  if (!Array.isArray(input) || input.length > limit) throw new InvalidLoginAdmissionRules();
  return input;
};
const unique = <T>(items: readonly T[], key: (item: T) => string): T[] => {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(item);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const utf8Bytes = (text: string): number => new TextEncoder().encode(text).byteLength;

/**
 * Validates and normalizes an untrusted rules document: exact keys, bounded
 * lists, trimmed values and duplicates removed (case-insensitively). A pattern
 * of `*` deliberately admits every verified value of the attribute. Throws
 * `InvalidLoginAdmissionRules`.
 */
export function parseLoginAdmissionRules(input: unknown): LoginAdmissionRules {
  const rules = record(input);
  const keys = ["enabled", "allowlist", "patterns", "conditions", "admitFunction"];
  if (Object.keys(rules).length !== keys.length || !keys.every((key) => Object.hasOwn(rules, key)))
    throw new InvalidLoginAdmissionRules();
  if (typeof rules.enabled !== "boolean") throw new InvalidLoginAdmissionRules();
  const allowlist = unique(list(rules.allowlist, LOGIN_ADMISSION_LIMITS.allowlist).map(value), normalizeValue);
  const patterns = unique(list(rules.patterns, LOGIN_ADMISSION_LIMITS.patterns).map(value), normalizeValue);
  const conditions = unique(
    list(rules.conditions, LOGIN_ADMISSION_LIMITS.conditions).map((item) => {
      const condition = record(item);
      if (Object.keys(condition).length !== 2 || !isAttributeName(condition.attribute))
        throw new InvalidLoginAdmissionRules();
      return { attribute: condition.attribute, equals: value(condition.equals) };
    }),
    (condition) => JSON.stringify([condition.attribute, normalizeValue(condition.equals)]),
  );
  let admitFunction: string | null = null;
  if (rules.admitFunction !== null) {
    if (
      typeof rules.admitFunction !== "string" ||
      !rules.admitFunction.trim() ||
      utf8Bytes(rules.admitFunction) > LOGIN_ADMISSION_LIMITS.functionBytes
    )
      throw new InvalidLoginAdmissionRules();
    admitFunction = rules.admitFunction;
  }
  return Object.freeze({
    enabled: rules.enabled,
    allowlist: Object.freeze(allowlist),
    patterns: Object.freeze(patterns),
    conditions: Object.freeze(conditions.map((condition) => Object.freeze(condition))),
    admitFunction,
  });
}

/** Example shown in the editor; the function receives `LoginAdmissionFunctionInput` by default. */
export const ADMIT_FUNCTION_EXAMPLE = `function admit(input) {
  // input.identity: { provider, subject, value, attributes }
  return { allow: input.identity.value.endsWith(".research") };
}`;
