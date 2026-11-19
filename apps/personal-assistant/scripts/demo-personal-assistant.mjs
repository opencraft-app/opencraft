import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { personalScenario } from "./personal-scenario.mjs";
const { values: v } = parseArgs({
  options: { directory: { type: "string" }, scenario: { type: "string" } },
});
await personalScenario({
  directory: v.directory ?? join(resolve(import.meta.dirname, "../profiles"), `personal-${Date.now()}`),
  owner: "local:personal-demo",
  mode: "fixture",
  timeoutMs: 15000,
  scenarios: v.scenario?.split(","),
});
