import { describe, expect, it } from "vitest";

import { planBotCreation, resolveBotCloneIntent } from "@lightvela/agent-core";

describe("shared Agent creation decisions", () => {
  it("creates the first instance and preserves its Soul template", () => {
    expect(planBotCreation({
      supportsNestedBots: true,
      instances: [],
      intent: { name: "First Bot", soulTemplateId: "soul-1" },
    })).toEqual({ kind: "create-instance", name: "First Bot", soulTemplateId: "soul-1" });
  });

  it("creates an additional Bot on the first Running instance", () => {
    expect(planBotCreation({
      supportsNestedBots: true,
      instances: [
        { instanceId: "ins-deleted", status: "Deleted" },
        { instanceId: "ins-running", status: "Active" },
      ],
      intent: { name: "Worker", description: "  useful  ", mode: "blank" },
    })).toEqual({
      kind: "create-nested-bot",
      instanceId: "ins-running",
      name: "Worker",
      description: "useful",
      mode: "blank",
    });
  });

  it("does not treat provisioning instances as a Bot host", () => {
    expect(planBotCreation({
      supportsNestedBots: true,
      instances: [{ instanceId: "ins-creating", status: "Creating" }],
      intent: { name: "New instance" },
    })).toEqual({ kind: "create-instance", name: "New instance" });
  });

  it("keeps sites without nested Bot support on instance creation", () => {
    expect(planBotCreation({
      supportsNestedBots: false,
      instances: [{ instanceId: "ins-running", status: "Running" }],
      intent: { name: "Global Bot" },
    })).toEqual({ kind: "create-instance", name: "Global Bot" });
  });

  it("resolves blank, current and main clone selections explicitly", () => {
    expect(resolveBotCloneIntent({
      isInitialCreation: true,
      selection: "clone-current",
      currentBotId: "bot-current",
      mainBotId: "bot-main",
    })).toEqual({ ok: true, intent: { mode: "blank" } });

    expect(resolveBotCloneIntent({
      isInitialCreation: false,
      selection: "clone-current",
      currentBotId: "bot-current",
      mainBotId: "bot-main",
    })).toEqual({ ok: true, intent: { mode: "clone", sourceBotId: "bot-current" } });

    expect(resolveBotCloneIntent({
      isInitialCreation: false,
      selection: "clone-main",
      currentBotId: "bot-current",
      mainBotId: "bot-main",
    })).toEqual({ ok: true, intent: { mode: "clone", sourceBotId: "bot-main" } });
  });

  it("reports a missing clone source instead of silently creating blank", () => {
    expect(resolveBotCloneIntent({
      isInitialCreation: false,
      selection: "clone-current",
      currentBotId: null,
      mainBotId: "bot-main",
    })).toEqual({ ok: false, reason: "source-bot-unavailable" });
  });

  it("carries an explicit clone intent into an additional Bot plan", () => {
    expect(planBotCreation({
      supportsNestedBots: true,
      instances: [{ instanceId: "ins-running", status: "Running" }],
      intent: {
        name: "Clone",
        mode: "clone",
        sourceBotId: "bot-main",
        initialSoul: "  soul text  ",
      },
    })).toEqual({
      kind: "create-nested-bot",
      instanceId: "ins-running",
      name: "Clone",
      mode: "clone",
      sourceBotId: "bot-main",
      initialSoul: "soul text",
    });
  });
});
