import { stat } from "node:fs/promises";
import type { OpenCraftHostStateDatabase } from "./opencraft-host-state-database.js";
import type { UsageRollout, UsageTurnKey } from "./token-usage-ledger.js";
import { scanRolloutTurnModels } from "./token-usage-rollout.js";

export interface BackfillModelsResult {
  readonly threads: number;
  readonly updatedTurns: number;
  readonly updatedSources: number;
  readonly unknownTurns: number;
  readonly missingRollouts: number;
}

/** A preview only reads rollout references and checks whether a Turn exists. */
export interface TokenUsageModelBackfillLedger {
  rollouts(after: string, limit: number): readonly Pick<UsageRollout, "threadId" | "path">[];
  readTurn(key: UsageTurnKey): UsageTurnKey | null;
  correctTurnIdentities(key: UsageTurnKey, provider: string | null, model: string | null): boolean;
}

export async function backfillTokenUsageModels(options: {
  readonly state?: OpenCraftHostStateDatabase;
  readonly ledger: TokenUsageModelBackfillLedger;
  readonly nativeHome?: string;
  readonly apply: boolean;
}): Promise<BackfillModelsResult> {
  let threads = 0;
  let updatedTurns = 0;
  let updatedSources = 0;
  let unknownTurns = 0;
  let missingRollouts = 0;

  let after = "";
  while (true) {
    const page = options.ledger.rollouts(after, 100);
    if (!page.length) break;
    for (const rollout of page) {
      after = rollout.threadId;
      threads++;
      try {
        await stat(rollout.path);
      } catch {
        missingRollouts++;
        continue;
      }
      const modelMap = await scanRolloutTurnModels(rollout.path);
      for (const [turnId, identity] of modelMap) {
        const turnKey = { threadId: rollout.threadId, turnId };
        const turn = options.ledger.readTurn(turnKey);
        if (!turn) continue;
        if (identity.provider || identity.model) {
          if (options.apply) {
            const changed = options.ledger.correctTurnIdentities(turnKey, identity.provider, identity.model);
            if (changed) {
              updatedTurns++;
              updatedSources++;
            }
          } else {
            // Dry run: check if there are null sources
            const before = options.ledger.readTurn(turnKey);
            if (before) {
              updatedTurns++;
              updatedSources++;
            }
          }
        } else {
          unknownTurns++;
        }
      }
    }
  }

  return {
    threads,
    updatedTurns,
    updatedSources,
    unknownTurns,
    missingRollouts,
  };
}
