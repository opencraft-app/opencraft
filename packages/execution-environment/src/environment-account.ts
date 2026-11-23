/** A verified login binding of a Human Actor, as the Actor store holds it. */
export interface EnvironmentLoginBinding {
  readonly provider: string;
  readonly subject: string;
}
/** The verified owner of an execution: a current, enabled Human Actor, its
 * generation and every login binding verified for it. */
export interface EnvironmentAccountOwner {
  readonly actorId: string;
  readonly actorGeneration: number;
  readonly bindings: readonly EnvironmentLoginBinding[];
}
/** Trusted compiled composition code only, never request data or configuration.
 * Chooses the vault account partition of an owner: its canonical
 * `actor:<id>` partition or the login partition (`<provider>:<subject>`) of
 * one of its verified bindings. `null` means no unique choice and is refused.
 * It runs inside the vault owner's turn and must not await. */
export type EnvironmentAccountMapping = (owner: EnvironmentAccountOwner) => string | null;
/** Durable, read-only Actor projection inside the vault owner. */
export interface EnvironmentAccountReader {
  /** The current enabled Human Actor with its verified bindings, or `null`. */
  owner(actorId: string): EnvironmentAccountOwner | null;
  /** The Actor a verified login binding belongs to, or `null`. */
  actorOf(binding: EnvironmentLoginBinding): string | null;
}
/** A partition chosen for one owner. `current()` rereads the owner and the
 * mapping and is false once either changed. */
export interface EnvironmentAccountSelection {
  readonly partition: string;
  current(): boolean;
}
/** How a vault owner turns a verified owner into the partition it reads. */
export interface EnvironmentAccountResolver {
  /** For the canonical Actor account of a durable admission. */
  forActor(account: string, actorGeneration: number): EnvironmentAccountSelection;
  /** For the login account (`<provider>:<subject>`) of an authenticated submission. */
  forLogin(account: string): EnvironmentAccountSelection;
}

const ACTOR = "actor:";
const text = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\x00-\x1f\x7f]/u.test(value);
/** The partition a login binding names: core's existing `<provider>:<subject>` form. */
export const environmentLoginPartition = (binding: EnvironmentLoginBinding) => `${binding.provider}:${binding.subject}`;
const refused = (): never => {
  throw Error("environment_account_unavailable");
};

/** Applies an installation's account mapping and keeps the result honest: the
 * partition is the owner's canonical one or exactly one verified binding's,
 * the binding's provider is not ambiguous for that Actor, and every recheck
 * rereads the owner and the mapping. Without a resolver, vault owners keep
 * reading the canonical Actor partition. */
export class EnvironmentAccountPartitions implements EnvironmentAccountResolver {
  constructor(
    private readonly reader: EnvironmentAccountReader,
    private readonly mapping: EnvironmentAccountMapping,
  ) {
    if (
      !reader ||
      typeof reader.owner !== "function" ||
      typeof reader.actorOf !== "function" ||
      typeof mapping !== "function"
    )
      throw Error("Invalid environment account mapping");
  }

  forActor(account: string, actorGeneration: number): EnvironmentAccountSelection {
    if (!text(account) || !account.startsWith(ACTOR) || !Number.isSafeInteger(actorGeneration)) return refused();
    return this.#select(account.slice(ACTOR.length), actorGeneration, null);
  }

  forLogin(account: string): EnvironmentAccountSelection {
    if (!text(account)) return refused();
    // A provider may itself contain ':'; every split that names a verified
    // binding is a candidate, and anything but exactly one is ambiguous.
    const matches: { binding: EnvironmentLoginBinding; actorId: string }[] = [];
    for (let i = account.indexOf(":"); i > 0 && i < account.length - 1; i = account.indexOf(":", i + 1)) {
      const binding = { provider: account.slice(0, i), subject: account.slice(i + 1) };
      const actorId = this.reader.actorOf(binding);
      if (actorId !== null) matches.push({ binding, actorId });
    }
    if (matches.length !== 1 || !text(matches[0]!.actorId)) return refused();
    const { binding, actorId } = matches[0]!;
    return this.#select(actorId, null, binding);
  }

  #owner(actorId: string, generation: number | null, binding: EnvironmentLoginBinding | null) {
    const owner = this.reader.owner(actorId);
    if (
      !owner ||
      owner.actorId !== actorId ||
      !Number.isSafeInteger(owner.actorGeneration) ||
      (generation !== null && owner.actorGeneration !== generation) ||
      !Array.isArray(owner.bindings) ||
      owner.bindings.length > 64 ||
      owner.bindings.some((b) => !b || !text(b.provider) || !text(b.subject))
    )
      return refused();
    const bindings = owner.bindings
      .map((b) => Object.freeze({ provider: b.provider, subject: b.subject }))
      .sort((a, b) => (environmentLoginPartition(a) < environmentLoginPartition(b) ? -1 : 1));
    if (
      binding &&
      (this.reader.actorOf(binding) !== actorId ||
        !bindings.some((b) => b.provider === binding.provider && b.subject === binding.subject))
    )
      return refused();
    return Object.freeze({
      actorId,
      actorGeneration: owner.actorGeneration,
      bindings: Object.freeze(bindings),
    });
  }

  #partition(owner: EnvironmentAccountOwner): string {
    let chosen: unknown;
    try {
      chosen = this.mapping(owner);
    } catch {
      return refused();
    }
    // A thenable or any non-text result is not a choice.
    if (!text(chosen)) return refused();
    if (chosen === ACTOR + owner.actorId) return chosen;
    if (chosen.startsWith(ACTOR) || chosen.startsWith("platform:")) return refused();
    const named = owner.bindings.filter((b) => environmentLoginPartition(b) === chosen);
    // Exactly one binding names it, and the Actor holds no other binding of
    // that provider: a provider with two logins is ambiguous.
    if (named.length !== 1 || owner.bindings.filter((b) => b.provider === named[0]!.provider).length !== 1)
      return refused();
    return chosen;
  }

  #select(
    actorId: string,
    generation: number | null,
    binding: EnvironmentLoginBinding | null,
  ): EnvironmentAccountSelection {
    if (!text(actorId)) return refused();
    const owner = this.#owner(actorId, generation, binding);
    const key = JSON.stringify(owner);
    const partition = this.#partition(owner);
    // The mapping is composition code: the owner is reread after it returns.
    const current = () => {
      try {
        const now = this.#owner(actorId, generation, binding);
        return JSON.stringify(now) === key && this.#partition(now) === partition;
      } catch {
        return false;
      }
    };
    if (!current()) return refused();
    return Object.freeze({ partition, current });
  }
}
