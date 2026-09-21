import { Service, type Inject } from "@deepseek-ai/cordis";
import { desiredRuntimeHint } from "./execution-profile.ts";
import {
  projectedThreadSettings,
  type ThreadSettingsShape,
} from "./transparent-thread-routing.ts";
import type {
  TransparentThreadSettingsPort,
  TransparentThreadSettingsRequest,
} from "../types/transparent-thread-settings.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import { asJsonValue, type JsonValue } from "../types/domain.ts";
import type { TransparentRuntimeUpdate } from "../types/transparent-binding.ts";

type Dependencies =
  | "appServer"
  | "threadManager"
  | "transparentRuntimeAccess"
  | "transparentThreadBinding";

function settingsShape(value: unknown): ThreadSettingsShape {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const settings: ThreadSettingsShape = {};
  for (const [key, item] of Object.entries(value)) settings[key] = item;
  return settings;
}

function jsonRecord(value: Record<string, unknown>): Record<string, JsonValue> {
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = asJsonValue(item);
  return result;
}

/**
 * Stages settings for the next immutable Turn execution profile.
 *
 * A settings update is acknowledged locally because it must not mutate the
 * identity of a Runtime that may still be executing the current Turn.
 */
export class TransparentThreadSettingsService extends Service
  implements TransparentThreadSettingsPort {
  static inject = [
    "appServer",
    "threadManager",
    "transparentRuntimeAccess",
    "transparentThreadBinding",
  ] satisfies Inject<Pick<HypernodeServices, Dependencies>>;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "transparentThreadSettings");
  }

  update(request: TransparentThreadSettingsRequest): void {
    const runtimeHint = this.ctx.transparentThreadBinding.runtimeHintFor(request.threadId) ?? {};
    const desired = desiredRuntimeHint(runtimeHint) ?? {};
    const providerId = request.provider?.id ?? request.provider?.providerId ?? null;
    const state = this.ctx.transparentRuntimeAccess.stateForOuter(request.threadId);
    const threadSettings = projectedThreadSettings(
      settingsShape(request.message.params),
      settingsShape(desired.threadSettings),
      settingsShape(state?.openResults?.get(request.threadId)),
      settingsShape(this.ctx.threadManager.get(request.threadId)),
      providerId ?? "openai",
    );
    const update: TransparentRuntimeUpdate = {
      nextProviderId: providerId,
      nextModel: threadSettings.model,
      nextThreadSettings: jsonRecord(threadSettings),
    };
    this.ctx.transparentThreadBinding.setRuntimeHint(request.threadId, update);
    this.ctx.threadManager.changed(request.threadId);
    const response = {
      ...(request.message.id !== undefined ? { id: request.message.id } : {}),
      result: {},
    };
    this.ctx.appServer.send(request.connection, response);
    this.ctx.appServer.audit(request.connection, "rpc.response", {
      id: request.message.id,
      method: request.message.method,
      ...this.ctx.appServer.summarizeResult(response.result),
    });
    this.ctx.appServer.broadcastNotification("thread/settings/updated", {
      threadId: request.threadId,
      threadSettings,
    });
    console.info(
      `[transparent-codex] thread settings routed outer=${request.threadId} ` +
      `model=${threadSettings.model} provider=${providerId ?? "openai"}`,
    );
  }
}
