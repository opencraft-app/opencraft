import { validGitGrantScope, type GitGrantScope } from "./personal-git-protocol.js";

/** Asynchronous vault-owner port for personal Git grants. It has the shape of
 * the ENV vault-owner ports: a public fingerprint (here the grant `authority`)
 * and an async `seal` that resolves to an opaque value. The caller never holds
 * the vault key; the owner serves no method that returns it. */
export interface PersonalGitSealPort {
  readonly authority: string;
  seal(scope: GitGrantScope): Promise<string>;
}

export const validPersonalGitSealPort = (value: unknown): value is PersonalGitSealPort =>
  !!value &&
  typeof value === "object" &&
  typeof (value as PersonalGitSealPort).authority === "string" &&
  /^[a-f0-9]{64}$/u.test((value as PersonalGitSealPort).authority) &&
  typeof (value as PersonalGitSealPort).seal === "function";

/** Exactly the fields a grant seals, in a fixed order. A Project or any other
 * field never crosses the port and never decides equality. */
export function personalGitGrantFields(scope: GitGrantScope): GitGrantScope {
  const { account, hostId, threadId, inputId, executionId, leaseGeneration, actorGeneration, membershipRevision } =
    scope;
  return Object.freeze({
    account,
    hostId,
    threadId,
    inputId,
    executionId,
    leaseGeneration,
    ...(actorGeneration === undefined ? {} : { actorGeneration }),
    ...(membershipRevision === undefined ? {} : { membershipRevision }),
  });
}

const unavailable = (): never => {
  throw Error("personal_git_execution_unavailable");
};

/** Serves `PersonalGitSealPort` inside the vault owner (a Worker). A scope is
 * sealed only while it equals the owner's own durable admission, read before
 * and after signing; a caller-supplied scope is a claim, never the authority. */
export class PersonalGitSealOwner {
  readonly authority: string;
  #sign: ((scope: GitGrantScope) => string) | undefined;
  constructor(
    vault: {
      personalGitAuthority(accountMode?: "principal" | "actor"): string;
      sealPersonalGitGrant(scope: GitGrantScope): string;
    },
    /** The durable admission naming this Host, Thread and input, or `null`. */
    private readonly admission: (scope: GitGrantScope) => GitGrantScope | null,
    private readonly accountMode: "principal" | "actor" = "actor",
  ) {
    this.authority = vault.personalGitAuthority(accountMode);
    this.#sign = (scope) => vault.sealPersonalGitGrant(scope);
  }
  seal(raw: unknown): string {
    try {
      if (!this.#sign || !validGitGrantScope(raw)) return unavailable();
      const claim = personalGitGrantFields(raw);
      if ((this.accountMode === "actor") !== claim.account.startsWith("actor:human://")) return unavailable();
      const expected = JSON.stringify(claim);
      const current = () => {
        const admitted = this.#sign ? this.admission(claim) : null;
        if (!admitted || !validGitGrantScope(admitted) || JSON.stringify(personalGitGrantFields(admitted)) !== expected)
          unavailable();
      };
      current();
      const capability = this.#sign(claim);
      current();
      return capability;
    } catch {
      return unavailable();
    }
  }
  /** Later seals are refused; the vault itself is closed by its owner. */
  close() {
    this.#sign = undefined;
  }
}
