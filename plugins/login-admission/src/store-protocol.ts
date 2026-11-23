// Messages between the policy (network thread) and its storage Worker. No runtime imports.

export interface StoredIdentity {
  readonly subject: string;
  /** Canonical JSON object of the verified attributes. */
  readonly attributes: string;
}

export interface StoredPolicy {
  /** 0 when nothing was published or imported for this scope. */
  readonly revision: number;
  /** Canonical JSON of the rules, or null at revision 0. */
  readonly rules: string | null;
  readonly updatedAt: number | null;
  readonly identities: readonly StoredIdentity[];
}

export interface StoredHistory {
  readonly versions: readonly { readonly revision: number; readonly rules: string; readonly at: number }[];
  readonly audit: readonly {
    readonly revision: number;
    readonly action: string;
    readonly at: number;
    readonly operator: string;
  }[];
}

export interface StoredImport {
  /** False when this source was already imported. */
  readonly imported: boolean;
  /** True when the imported rules became the published document (no earlier document existed). */
  readonly applied: boolean;
}

/** Calls the network thread sends to the storage Worker, in arrival order. */
export interface LoginAdmissionStoreMethods {
  load(policy: string): StoredPolicy;
  history(policy: string, limit: number): StoredHistory;
  /** CAS: commits revision `expected + 1` with its version and audit rows, or throws `LoginAdmissionConflict`. */
  publish(policy: string, expected: number, rules: string, operator: string, at: number, detail: string): number;
  /** Remembers a verified identity so later decisions (durable work, a new policy) need no live login. */
  recordIdentity(policy: string, subject: string, attributes: string, at: number): void;
  /** One-time adoption of an existing policy store, keyed by `source`. */
  importPolicy(
    policy: string,
    source: string,
    rules: string,
    identities: readonly StoredIdentity[],
    operator: string,
    at: number,
    detail: string,
  ): StoredImport;
}

export interface LoginAdmissionStoreData {
  readonly path: string;
}

/** The stored revision moved: another administrator published first. */
export class LoginAdmissionConflict extends Error {
  constructor(message = "revision_conflict") {
    super(message);
    this.name = "LoginAdmissionConflict";
  }
}
