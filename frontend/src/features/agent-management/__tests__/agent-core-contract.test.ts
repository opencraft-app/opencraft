import { describe, expect, it } from "vitest";

import {
  createBotIdentity,
  botIdentityKey,
  normalizeBotLifecycle,
  projectBotCatalog,
  resolveSelectedBotKey,
  sameBotInstance,
} from "@lightvela/agent-core";

describe("shared agent core first-consumer contract", () => {
it("keeps instance, Bot and profile identities distinct", () => {
  const main = createBotIdentity({ botId: "bot-main", instanceId: "ins-1", profileId: "main", isDefault: true });
  const sales = createBotIdentity({ botId: "bot-sales", instanceId: "ins-1", profileId: "sales", isDefault: false });
  expect(main).toEqual({ botId: "bot-main", instanceId: "ins-1", profileId: "main", isDefault: true, legacy: false });
  expect(sameBotInstance(main, sales)).toBe(true);
  expect(main.botId).not.toBe(main.instanceId);
  expect(botIdentityKey(main)).not.toBe(botIdentityKey(sales));
});

it("does not collapse the same profile-shaped Bot ID across physical instances", () => {
  const entries = projectBotCatalog([
    { id: "sales", instanceId: "ins-1", profileId: "sales", isDefault: false, name: "Sales one", status: "active", createdAt: "2026-01-01" },
    { id: "sales", instanceId: "ins-2", profileId: "sales", isDefault: false, name: "Sales two", status: "active", createdAt: "2026-01-02" },
  ]);
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((entry) => entry.key)).size).toBe(2);
});

it("normalizes backend lifecycle spellings once", () => {
  expect(["running", "Active", "ready", "Succeeded"].map(normalizeBotLifecycle)).toEqual(["running", "running", "running", "running"]);
  expect(["creating", "queued", "provisioning"].map(normalizeBotLifecycle)).toEqual(["provisioning", "provisioning", "provisioning"]);
  expect(normalizeBotLifecycle("Deleted")).toBe("deleting");
  expect(normalizeBotLifecycle("something-new")).toBe("draft");
});

it("projects a deterministic catalog and preserves selection when possible", () => {
  const entries = projectBotCatalog([
    { id: "b", instanceId: "ins-2", profileId: "worker", isDefault: false, name: "Beta", status: "active", createdAt: "2026-01-02" },
    { id: "a", instanceId: "ins-1", profileId: "main", isDefault: true, name: "Alpha", status: "paused", createdAt: "2026-01-01" },
    { id: "a", instanceId: "ins-1", profileId: "main", isDefault: true, name: "Duplicate", status: "failed", createdAt: "2026-01-03" },
  ]);
  expect(entries.map((entry) => entry.identity.botId)).toEqual(["b", "a"]);
  expect(entries[1]?.lifecycle).toBe("paused");
  expect(entries[1]?.source.name).toBe("Alpha");
  expect(resolveSelectedBotKey(entries, { requestedKey: entries[0]?.key, currentKey: entries[1]?.key })).toBe(entries[0]?.key);
  expect(resolveSelectedBotKey(entries, { requestedKey: "missing", currentKey: entries[1]?.key })).toBe(entries[1]?.key);
  expect(resolveSelectedBotKey(entries, { requestedKey: "missing", currentKey: "missing" })).toBe(entries[0]?.key);
});

it("marks legacy instance-shaped Bots without guessing a nested identity", () => {
  expect(createBotIdentity({ botId: "ins-1", instanceId: "ins-1" })).toEqual({
    botId: "ins-1", instanceId: "ins-1", profileId: "main", isDefault: true, legacy: true,
  });
});
});
