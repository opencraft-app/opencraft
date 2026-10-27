import { parseArgs } from "node:util";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { TokenUsageStateDatabase } from "../apps/opencraft-daemon/src/token-usage-state-database.js";
import { OpenCraftTokenUsageLedger } from "../apps/opencraft-daemon/src/token-usage-ledger.js";
import { backfillTokenUsageModels, type TokenUsageModelBackfillLedger } from "../apps/opencraft-daemon/src/token-usage-model-backfill.js";

const { values } = parseArgs({
  options: {
    "data-dir": { type: "string" },
    "server-id": { type: "string" },
    "apply": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    "help": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  if (values.help) {
    console.log("Usage: npx tsx scripts/backfill-token-usage-models.ts --data-dir DIR --server-id ID [--dry-run | --apply]");
    console.log("Targets an existing token-usage.sqlite. Preview is read-only. Stop the collector before --apply.");
    console.log("Environment: OPENCRAFT_USAGE_DATA_DIR (legacy: OPENCRAFT_CODEX_DATA_DIR), OPENCRAFT_SERVER_ID.");
    return;
  }
  const directory = (values["data-dir"] ?? (process.env.OPENCRAFT_USAGE_DATA_DIR?.trim() || process.env.OPENCRAFT_CODEX_DATA_DIR))?.trim();
  const serverId = (values["server-id"] ?? process.env.OPENCRAFT_SERVER_ID)?.trim();
  if (!directory || !serverId || serverId.length > 1024) {
    throw new Error("Explicit --data-dir and --server-id (or their environment variables) are required");
  }
  const dataDir = resolve(directory);
  const apply = values.apply === true && values["dry-run"] !== true;
  // A read-only open rejects missing targets without creating a directory or DB.
  const preview = new DatabaseSync(join(dataDir, "token-usage.sqlite"), { readOnly: true });
  try {
    preview.exec("BEGIN");
    if (!preview.prepare("SELECT 1 FROM token_usage_scopes WHERE server_id=?").get(serverId)) {
      throw new Error("Server ID is not present in the selected token usage database");
    }
    if (!apply) {
      const rollouts = preview.prepare("SELECT thread_id,path FROM token_usage_rollouts WHERE server_id=? AND thread_id>? ORDER BY thread_id LIMIT ?");
      const turn = preview.prepare("SELECT 1 FROM token_usage_turns WHERE server_id=? AND thread_id=? AND turn_id=?");
      const ledger: TokenUsageModelBackfillLedger = {
        rollouts: (after, limit) => rollouts.all(serverId, after, limit).map(row => ({ threadId: String(row.thread_id), path: String(row.path) })),
        readTurn: key => turn.get(serverId, key.threadId, key.turnId) ? key : null,
        correctTurnIdentities: () => { throw new Error("Preview cannot write model identities"); },
      };
      const result = await backfillTokenUsageModels({ ledger, apply: false });
      console.log(JSON.stringify({ passed: true, apply: false, ...result }, null, 2));
      return;
    }
    if (preview.prepare("SELECT 1 FROM token_usage_attempts WHERE server_id=? AND outcome='pending' LIMIT 1").get(serverId)) {
      throw new Error("Pending delivery attempts exist; stop and reconcile the collector before applying a backfill");
    }
  } finally {
    preview.close();
  }

  const state = new TokenUsageStateDatabase(dataDir);
  try {
    const ledger = new OpenCraftTokenUsageLedger(state, serverId);
    const result = await backfillTokenUsageModels({ ledger, apply: true });
    console.log(JSON.stringify({ passed: true, apply: true, ...result }, null, 2));
  } finally {
    state.close();
  }
}

await main().catch(error => {
  console.error(error instanceof Error ? error.message : "Token usage backfill failed");
  process.exitCode = 1;
});
