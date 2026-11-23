// Registers shared WorkerScenarios as node:test cases on the Miniflare runtime.
import { after, before, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { miniflareRuntime } from "./miniflare-runtime.ts";
import type { WorkerScenario } from "./worker-runtime.ts";

export function testScenariosOnMiniflare(label: string, scenarios: readonly WorkerScenario[]): void {
  const runtime = miniflareRuntime();
  let scratch = "";
  before(async () => { scratch = await mkdtemp(join(tmpdir(), `${label}-`)); });
  after(async () => {
    await runtime.dispose();
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });
  for (const scenario of scenarios)
    test(scenario.name, (t) => scenario.run({ runtime, scratch, diagnostic: (line) => t.diagnostic(line) }));
}
