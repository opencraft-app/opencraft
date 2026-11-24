import { acquireOwnerLock } from "@opencraft/sqlite-node/writer-lock";
import { parseArgs } from "node:util";
import { realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readModelConfiguration } from "./longmemeval.mjs";
import { loadProfile } from "../src/adapters/local/profile.mjs";
import { createLocalDomain } from "../src/runtime/create-local-domain.mjs";
import { ModelCatalog } from "../src/adapters/models/model-catalog.mjs";
import { ReceptionModel } from "../src/adapters/models/reception-model.mjs";
import { ReceptionPlanner } from "../src/application/reception/planner.mjs";

const { values: v } = parseArgs({
  options: {
    profile: { type: "string" },
    "model-config": { type: "string" },
    output: { type: "string" },
  },
});
if (!v.profile || !v["model-config"] || !v.output)
  throw new Error("Expected --profile EVALUATED_PROFILE --model-config PRIVATE_JSON --output NEW_FILE");
const config = await readModelConfiguration(v["model-config"]);
process.env[
  {
    deepseek: "DEEPSEEK_API_KEY",
    anthropic: "ANTHROPIC_API_KEY",
    "openai-compatible": "OPENCRAFT_EVAL_API_KEY",
  }[config.provider]
] = config.apiKey;
const profile = loadProfile(resolve(v.profile));
for (const field of ["provider", "modelId", "baseUrl", "thinking"]) {
  if (profile.config.model?.[field] !== config[field])
    throw new Error("Model configuration must match evaluated profile");
}
// The runner's profile lock: no live runner may write the evaluated profile meanwhile.
const release = await acquireOwnerLock(`${await realpath(profile.path)}.lock`);
let app, uow;
try {
  ({ app, uow } = createLocalDomain(profile));
} catch (error) {
  await release();
  throw error;
}
try {
  const turn = app.reception.turn("evaluation-query");
  const history = app.history.view().messages;
  const byId = new Map(history.map((message) => [message.id, message]));
  // Query time comes from the original evaluated query, not current wall time.
  app.receptionQueries.now = () => turn.created_at;
  const input = app.reception.context(turn);
  const baselineMessagesHaveTime = input.messages.some((message) => "occurredAt" in message || "at" in message);
  input.messages = input.messages.map((message) => ({
    ...message,
    occurredAt: new Date(byId.get(message.id).at).toISOString(),
  }));
  const observations = [];
  const catalog = await ModelCatalog.open(profile);
  const planner = new ReceptionPlanner(
    new ReceptionModel(catalog, {
      recordUsage: (value) => observations.push(value),
    }),
    app.receptionQueries,
  );
  const result = await planner.plan(turn, input, AbortSignal.timeout(60000));
  const report = {
    model: catalog.configured.model,
    baseline: turn.reply_text,
    diagnosticProposal: result.proposal,
    queries: result.queries,
    baselineMessagesHaveTime,
    intervention:
      "Only add original canonical message timestamps to the read-only QA projection; no gold answer or question category is loaded",
    inputClock: input.clock,
    modelObservations: observations,
    benchmarkScore: false,
    originalResponseNotRewritten: true,
  };
  await writeFile(resolve(v.output), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      baseline: report.baseline,
      diagnosticProposal: report.diagnosticProposal,
      benchmarkScore: false,
    }),
  );
} finally {
  try {
    uow.close();
  } finally {
    await release();
  }
}
