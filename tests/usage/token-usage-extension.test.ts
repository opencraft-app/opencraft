import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Context } from "@deepseek-ai/cordis";
import { ExtensionManager, ExtensionSupervisor, MemoryExtensionInstallationPersistence, provideExtensionInstallationRepository } from "@opencraft/extension-runtime";
import { PlatformViewRendererRegistry } from "@opencraft/extension-react";
import { createPlatformViewRendererContributionAdapter } from "../../apps/workbench-web/src/runtime/platform-view-renderers";
import { tokenUsageBuiltin } from "../../apps/workbench-web/src/runtime/token-usage-builtin";
import { TokenUsageStateDatabase } from "../../apps/opencraft-daemon/src/token-usage-state-database";
import { OpenCraftTokenUsageLedger } from "../../apps/opencraft-daemon/src/token-usage-ledger";

for (const platform of ["web", "electron"] as const) test(`F-14/NF-11: ${platform} view retires 20 times while Host meters`, async () => {
  const directory = await mkdtemp(join(tmpdir(), "oc-token-extension-"));
  const state = new TokenUsageStateDatabase(directory);
  const at = Date.parse("2026-10-21T00:00:00Z");
  const ledger = new OpenCraftTokenUsageLedger(state, "server", () => at);
  const key = { threadId: "thread", turnId: "turn" };
  ledger.startTurn(key, at, "human", true);
  ledger.recordInput(key, { inputId: "start", actorId: "A", actorKind: "human", mode: "start", admission: "confirmed" });
  const context = new Context();
  const fiber = context.plugin(provideExtensionInstallationRepository(new MemoryExtensionInstallationPersistence()));
  await fiber;
  const renderers = new PlatformViewRendererRegistry();
  const supervisor = new ExtensionSupervisor({ platform, internalContributions: { platformViewRenderer: createPlatformViewRendererContributionAdapter(renderers) } });
  const manager = new ExtensionManager({ installations: context.extensionInstallations, supervisor, builtins: [tokenUsageBuiltin], loader: { async load() { throw new Error("No downloaded module needed"); } } });
  const total = () => ledger.query({ from: "2026-10-21", through: "2026-10-21" }, () => ({ actorId: "A", administrator: false })).summary.tokens;
  try {
    await manager.restore();
    for (let n = 0; n < 20; n++) {
      assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 1);
      assert.equal(supervisor.contributions.getSnapshot().views.length, 1);
      assert.equal(renderers.getSnapshot().renderers.length, 1);
      await manager.setEnabled(tokenUsageBuiltin.manifest.id, false);
      assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
      assert.equal(supervisor.contributions.getSnapshot().views.length, 0);
      assert.equal(renderers.getSnapshot().renderers.length, 0);
      ledger.recordSource({ ...key, lineage: "epoch", sourceId: String(n), kind: "response", version: 0, provider: "p", model: "m", counts: { totalTokens: "100" } });
      assert.equal(total(), String((n + 1) * 100));
      await manager.setEnabled(tokenUsageBuiltin.manifest.id, true);
      assert.equal(total(), String((n + 1) * 100));
    }
    ledger.reconcile(key, { executionState: "completed", participantsComplete: true, usageComplete: true, responsesComplete: true });
    assert.equal(ledger.readTurn(key)?.allocationState, "settled");
    await manager.setEnabled(tokenUsageBuiltin.manifest.id, false);
    await manager.restore();
    assert.equal(supervisor.contributions.getSnapshot().settingsPages.length, 0);
    assert.equal(total(), "2000");
  } finally {
    await manager.dispose(); await supervisor.dispose(); await fiber.dispose(); state.close();
    await rm(directory, { recursive: true, force: true });
  }
});
