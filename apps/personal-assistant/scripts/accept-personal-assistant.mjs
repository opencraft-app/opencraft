import { parseArgs } from "node:util";
import { personalScenario } from "./personal-scenario.mjs";

const { values: v } = parseArgs({
  options: {
    directory: { type: "string" },
    owner: { type: "string" },
    provider: { type: "string" },
    model: { type: "string" },
    mode: { type: "string" },
    scenario: { type: "string" },
    "timeout-ms": { type: "string" },
  },
});
if (v.mode && v.mode !== "model")
  throw new Error(
    "accept:real refuses fixture mode; use demo:personal for mechanism evidence",
  );
if (!v.directory || !v.owner || !v.provider || !v.model)
  throw new Error(
    "Required: --directory NEW_DIR --owner LABEL --provider deepseek|anthropic --model MODEL_ID",
  );
const timeoutMs = Number(v["timeout-ms"] ?? 120000);
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 300000)
  throw new Error("timeout-ms must be 1000..300000");
await personalScenario({
  directory: v.directory,
  owner: v.owner,
  mode: "model",
  model: { provider: v.provider, modelId: v.model },
  timeoutMs,
  scenarios: v.scenario?.split(","),
});
