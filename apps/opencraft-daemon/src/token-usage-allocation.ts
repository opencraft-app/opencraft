/** Token counts cross persistence and RPC boundaries as exact decimal integers. */
export type TokenCount = string;
export const TOKEN_ALLOCATION_POLICY = "equal-turn-v1" as const;

export function tokenInteger(value: unknown): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) return BigInt(value);
  throw new TypeError("Token count must be an exact nonnegative integer");
}

export interface TokenModelBucket {
  readonly provider: string | null;
  readonly model: string | null;
  readonly totalTokens: TokenCount;
}

export interface TokenActorAllocation {
  readonly actorId: string;
  readonly totalTokens: TokenCount;
}

export interface TokenAllocation {
  readonly policy: typeof TOKEN_ALLOCATION_POLICY;
  readonly totalTokens: TokenCount;
  readonly actors: readonly TokenActorAllocation[];
  readonly models: readonly (TokenModelBucket & { readonly actors: readonly TokenActorAllocation[] })[];
}

export function tokenModelKey(provider: string | null, model: string | null): string {
  return JSON.stringify([provider, model]);
}

/**
 * Allocate the complete turn before applying any query filters. Carry the
 * remainder offset between model buckets so both each model and the whole
 * turn conserve tokens, and no participant differs by more than one token.
 * Complexity depends on participants and models, never on the token count.
 */
export function allocateTurnTokens(buckets: readonly TokenModelBucket[], actorIds: readonly string[]): TokenAllocation {
  if (actorIds.some(id => typeof id !== "string" || !id)) throw new TypeError("Participant Actor ID is required");
  const actors = [...new Set(actorIds)].sort();
  if (!actors.length) throw new TypeError("Allocation requires confirmed participants");
  const grouped = new Map<string, { provider: string | null; model: string | null; total: bigint }>();
  for (const bucket of buckets) {
    const key = tokenModelKey(bucket.provider, bucket.model);
    const existing = grouped.get(key);
    const total = tokenInteger(bucket.totalTokens);
    if (existing) existing.total += total;
    else grouped.set(key, { provider: bucket.provider, model: bucket.model, total });
  }
  const totals = actors.map(() => 0n);
  const count = BigInt(actors.length);
  let offset = 0;
  let total = 0n;
  const models = [...grouped.keys()].sort().map(key => {
    const bucket = grouped.get(key)!;
    const quotient = bucket.total / count;
    const remainder = Number(bucket.total % count);
    const shares = actors.map((actorId, index) => {
      const distance = (index - offset + actors.length) % actors.length;
      const share = quotient + (distance < remainder ? 1n : 0n);
      totals[index] = totals[index]! + share;
      return { actorId, totalTokens: share.toString() };
    });
    offset = (offset + remainder) % actors.length;
    total += bucket.total;
    return { provider: bucket.provider, model: bucket.model, totalTokens: bucket.total.toString(), actors: shares };
  });
  return {
    policy: TOKEN_ALLOCATION_POLICY,
    totalTokens: total.toString(),
    actors: actors.map((actorId, index) => ({ actorId, totalTokens: totals[index]!.toString() })),
    models,
  };
}
