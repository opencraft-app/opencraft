import { Service, type Inject } from "@deepseek-ai/cordis";
import type { ModelProviderRecord } from "../types/account-config.ts";
import type { AppServerConnection, AppServerParams } from "../types/appserver.ts";
import type { HypernodeContext, HypernodeServices } from "../types/context.ts";
import type {
  MergedModelCatalogPage,
  ModelCatalogEntry,
  ModelCatalogPage,
  ModelCatalogPort,
  ModelReasoningEffort,
} from "../types/model-catalog.ts";

function reasoning(reasoningEffort: string, description: string): ModelReasoningEffort {
  return { reasoningEffort, description };
}

const subscriptionFallbackModel: ModelCatalogEntry = {
  id: "gpt-5.6-sol",
  model: "gpt-5.6-sol",
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  displayName: "GPT-5.6-Sol",
  description: "Latest frontier agentic coding model.",
  modelSpecialty: null,
  hidden: false,
  supportedReasoningEfforts: [
    reasoning("low", "Fast responses with lighter reasoning"),
    reasoning("medium", "Balances speed and reasoning depth for everyday tasks"),
    reasoning("high", "Greater reasoning depth for complex problems"),
    reasoning("xhigh", "Extra high reasoning depth for complex problems"),
    reasoning("max", "Maximum reasoning depth for the hardest problems"),
    reasoning("ultra", "Maximum reasoning with automatic task delegation"),
  ],
  defaultReasoningEffort: "low",
  inputModalities: ["text", "image"],
  supportsPersonality: false,
  multiAgentVersion: "v2",
  additionalSpeedTiers: ["fast"],
  serviceTiers: [{ id: "priority", name: "Fast", description: "1.5x speed, increased usage" }],
  defaultServiceTier: null,
  isDefault: true,
};

const subscriptionFallbackModels = [subscriptionFallbackModel];
const customCursorPrefix = "hypernode-public:";

function requiredModel(record: ModelProviderRecord): string {
  if (typeof record.model !== "string" || record.model.length === 0) {
    throw new Error(`model provider ${record.providerId} has no model id`);
  }
  return record.model;
}

function projectedModel(
  record: ModelProviderRecord,
  isDefault = false,
  inputModalities: string[] = ["text"],
): ModelCatalogEntry {
  const model = requiredModel(record);
  const endpoint = String(record.endpoint ?? "");
  return {
    ...subscriptionFallbackModel,
    id: model,
    model,
    displayName: String(record.displayName ?? model),
    description: record.visibility === "public"
      ? `Public model routed through ${endpoint}`
      : `Private model routed through ${endpoint}`,
    serviceTiers: [],
    additionalSpeedTiers: [],
    defaultServiceTier: null,
    isDefault,
    inputModalities,
  };
}

function modelId(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  return (value as Record<string, unknown>)["id"];
}

function nativePage(result: unknown): Record<string, unknown> {
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? { ...(result as Record<string, unknown>) }
    : {};
}

function pageLimit(params: AppServerParams, fallback: number): number {
  const limit = params["limit"];
  return limit == null ? fallback : Math.max(1, Number(limit) || 1);
}

type Dependencies = "appServer" | "modelGateway" | "modelMetadata";

export class ModelCatalogService extends Service implements ModelCatalogPort {
  static inject = ["appServer", "modelGateway", "modelMetadata"] satisfies Inject<
    Pick<HypernodeServices, Dependencies>
  >;

  declare protected ctx: HypernodeContext<Dependencies>;

  constructor(ctx: HypernodeContext<Dependencies>) {
    super(ctx, "modelCatalog");
    ctx.effect(() => ctx.appServer.register("model/list", (params, connection) => (
      this.list(params, connection)
    )));
  }

  forConnection(connection: AppServerConnection): ModelCatalogEntry[] {
    const provider = typeof this.ctx.modelGateway.activeForConnection === "function"
      ? this.ctx.modelGateway.activeForConnection(connection)
      : null;
    const userId = connection.identity?.id;
    const records = this.ctx.modelGateway.visibleRecordsForUser(userId)
      .filter((record) => typeof record.model === "string" && record.model.length > 0);
    const byModel = new Map<string, ModelProviderRecord>();
    for (const record of records) {
      const model = requiredModel(record);
      const existing = byModel.get(model);
      if (existing === undefined || record.providerId === provider?.providerId ||
          (existing.visibility === "public" && record.visibility !== "public")) {
        byModel.set(model, record);
      }
    }
    const models = [...byModel.values()].map((record) => projectedModel(
      record,
      record.providerId === provider?.providerId,
      record.model === "auto"
        ? ["text"]
        : this.ctx.modelMetadata.inputModalitiesForRecord(record),
    ));
    return models.length > 0 ? models : subscriptionFallbackModels;
  }

  customModels(connection: AppServerConnection): ModelCatalogEntry[] {
    const userId = connection.identity?.id;
    const provider = typeof this.ctx.modelGateway.activeForConnection === "function"
      ? this.ctx.modelGateway.activeForConnection(connection)
      : null;
    return this.ctx.modelGateway.visibleRecordsForUser(userId)
      .filter((record) => typeof record.model === "string" && record.model.length > 0)
      .map((record) => projectedModel(
        record,
        record.providerId === provider?.providerId,
        record.model === "auto"
          ? ["text"]
          : this.ctx.modelMetadata.inputModalitiesForRecord(record),
      ));
  }

  isCustomCursor(cursor: unknown): cursor is string {
    return typeof cursor === "string" && cursor.startsWith(customCursorPrefix);
  }

  customPage(
    params: AppServerParams = {},
    connection: AppServerConnection,
  ): ModelCatalogPage | null {
    const cursor = params["cursor"];
    if (!this.isCustomCursor(cursor)) return null;
    const start = Number(cursor.slice(customCursorPrefix.length));
    const data = this.customModels(connection);
    if (!Number.isInteger(start) || start < 0 || start > data.length) {
      throw new Error(`invalid public model cursor ${JSON.stringify(cursor)}`);
    }
    const limit = pageLimit(params, data.length);
    const end = Math.min(data.length, start + limit);
    return {
      data: data.slice(start, end),
      nextCursor: end < data.length ? `${customCursorPrefix}${end}` : null,
    };
  }

  mergeSubscriptionPage(
    result: unknown = {},
    params: AppServerParams = {},
    connection: AppServerConnection,
  ): MergedModelCatalogPage {
    const page = nativePage(result);
    const rawData = page["data"];
    const nativeData: unknown[] = Array.isArray(rawData) ? rawData : [];
    this.ctx.modelGateway.observeNativeCodexModels?.(nativeData);
    if (page["nextCursor"] != null) {
      return { ...page, data: nativeData, nextCursor: String(page["nextCursor"]) };
    }
    const nativeIds = new Set(nativeData.map(modelId).filter((id) => id != null));
    const customData = this.customModels(connection).filter((item) => !nativeIds.has(item.id));
    const limit = pageLimit(params, nativeData.length + customData.length);
    const available = Math.max(0, limit - nativeData.length);
    return {
      ...page,
      data: [...nativeData, ...customData.slice(0, available)],
      nextCursor: available < customData.length ? `${customCursorPrefix}${available}` : null,
    };
  }

  list(
    params: AppServerParams = {},
    connection: AppServerConnection,
  ): ModelCatalogPage {
    const data = this.forConnection(connection);
    const cursor = params["cursor"];
    const start = cursor == null ? 0 : Number(cursor);
    if (!Number.isInteger(start) || start < 0 || start > data.length) {
      throw new Error(`invalid model cursor ${JSON.stringify(cursor)}`);
    }
    const limit = pageLimit(params, data.length);
    const end = Math.min(data.length, start + limit);
    return {
      data: data.slice(start, end),
      nextCursor: end < data.length ? String(end) : null,
    };
  }
}
