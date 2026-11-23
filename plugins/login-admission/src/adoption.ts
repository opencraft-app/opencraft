// Conversion of an earlier, deployment-specific admission document into core
// rules. Pure and runtime-neutral; the owner of the old store reads it (on its
// own Worker) and hands the result to `LoginAdmissionPolicy.adopt`.
import {
  DISABLED_RULES,
  InvalidLoginAdmissionRules,
  parseLoginAdmissionRules,
  type LoginAdmissionRules,
} from "./contract";
import type { LoginAdmissionIdentity } from "./rules";

/**
 * The single-mode document shape earlier policy stores kept:
 * - `{ mode: "inherit" }`: no restriction (existing admission applies);
 * - `{ mode: "allowlist", <list>: string[] }`: exact login values;
 * - `{ mode: "javascript", source }`: an `admit(input)` function.
 */
export type LegacyModeDocument =
  | { readonly mode: "inherit" }
  | { readonly mode: "allowlist"; readonly [list: string]: unknown }
  | { readonly mode: "javascript"; readonly source: string };

/**
 * Converts one mode document. `listKey` names the allowlist field (for example
 * `loginNames`). The function source is kept verbatim: whether its existing
 * `input` shape still matches is decided by the composition's `functionInput`.
 */
export function rulesFromModeDocument(document: unknown, listKey: string): LoginAdmissionRules {
  if (!document || typeof document !== "object" || Array.isArray(document)) throw new InvalidLoginAdmissionRules();
  const value = document as Record<string, unknown>;
  if (value.mode === "inherit") return DISABLED_RULES;
  if (value.mode === "allowlist") {
    return parseLoginAdmissionRules({
      enabled: true,
      allowlist: value[listKey],
      patterns: [],
      conditions: [],
      admitFunction: null,
    });
  }
  if (value.mode === "javascript") {
    return parseLoginAdmissionRules({
      enabled: true,
      allowlist: [],
      patterns: [],
      conditions: [],
      admitFunction: value.source,
    });
  }
  throw new InvalidLoginAdmissionRules();
}

/** Previously verified `(subject, login value)` pairs as identities of `provider`. */
export function identitiesFromLogins(
  provider: string,
  attribute: string,
  rows: readonly { readonly subject: string; readonly value: string }[],
): LoginAdmissionIdentity[] {
  return rows.map((row) => ({ provider, subject: row.subject, attributes: { [attribute]: row.value } }));
}
