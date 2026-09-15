import { normalizeBotLifecycle } from "./bot-lifecycle";

export type BotCloneSelection = "blank" | "clone-current" | "clone-main";

export type BotCloneIntent =
  | { mode: "blank" }
  | { mode: "clone"; sourceBotId: string };

export type BotCloneIntentResult =
  | { ok: true; intent: BotCloneIntent }
  | { ok: false; reason: "source-bot-unavailable" };

export interface BotCreationInstanceCandidate {
  instanceId: string;
  status: string;
}

export interface BotCreationIntent {
  name: string;
  description?: string;
  soulTemplateId?: string;
  mode?: "blank" | "clone";
  sourceBotId?: string;
  initialSoul?: string;
}

export type BotCreationPlan =
  | {
      kind: "create-instance";
      name: string;
      soulTemplateId?: string;
    }
  | {
      kind: "create-nested-bot";
      instanceId: string;
      name: string;
      description?: string;
      mode: "blank" | "clone";
      sourceBotId?: string;
      initialSoul?: string;
    };

export function resolveBotCloneIntent(input: {
  isInitialCreation: boolean;
  selection: BotCloneSelection;
  currentBotId?: string | null;
  mainBotId?: string | null;
}): BotCloneIntentResult {
  if (input.isInitialCreation || input.selection === "blank") {
    return { ok: true, intent: { mode: "blank" } };
  }

  const sourceBotId = (input.selection === "clone-current" ? input.currentBotId : input.mainBotId)?.trim();
  if (!sourceBotId) {
    return { ok: false, reason: "source-bot-unavailable" };
  }

  return { ok: true, intent: { mode: "clone", sourceBotId } };
}

export function planBotCreation(input: {
  supportsNestedBots: boolean;
  instances: readonly BotCreationInstanceCandidate[];
  intent: BotCreationIntent;
}): BotCreationPlan {
  const runningInstance = input.supportsNestedBots
    ? input.instances.find((instance) => normalizeBotLifecycle(instance.status) === "running")
    : undefined;

  if (!runningInstance) {
    return {
      kind: "create-instance",
      name: input.intent.name,
      ...(input.intent.soulTemplateId ? { soulTemplateId: input.intent.soulTemplateId } : {}),
    };
  }

  const description = input.intent.description?.trim();
  const initialSoul = input.intent.initialSoul?.trim();
  return {
    kind: "create-nested-bot",
    instanceId: runningInstance.instanceId,
    name: input.intent.name,
    ...(description ? { description } : {}),
    mode: input.intent.mode ?? "blank",
    ...(input.intent.sourceBotId ? { sourceBotId: input.intent.sourceBotId } : {}),
    ...(initialSoul ? { initialSoul } : {}),
  };
}
