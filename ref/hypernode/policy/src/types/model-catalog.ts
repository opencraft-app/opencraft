import type { AppServerConnection, AppServerParams } from "./appserver.ts";

export interface ModelReasoningEffort {
  reasoningEffort: string;
  description: string;
}

export interface ModelServiceTier {
  id: string;
  name: string;
  description: string;
}

export interface ModelCatalogEntry {
  id: string;
  model: string;
  upgrade: null;
  upgradeInfo: null;
  availabilityNux: null;
  displayName: string;
  description: string;
  modelSpecialty: null;
  hidden: boolean;
  supportedReasoningEfforts: ModelReasoningEffort[];
  defaultReasoningEffort: string;
  inputModalities: string[];
  supportsPersonality: boolean;
  multiAgentVersion: string;
  additionalSpeedTiers: string[];
  serviceTiers: ModelServiceTier[];
  defaultServiceTier: null;
  isDefault: boolean;
}

export interface ModelCatalogPage<out Entry = ModelCatalogEntry> {
  data: Entry[];
  nextCursor: string | null;
}

export type MergedModelCatalogPage = Record<string, unknown> & ModelCatalogPage<unknown>;

export interface ModelCatalogPort {
  forConnection(connection: AppServerConnection): ModelCatalogEntry[];
  customModels(connection: AppServerConnection): ModelCatalogEntry[];
  customPage(
    params: AppServerParams,
    connection: AppServerConnection,
  ): ModelCatalogPage | null;
  mergeSubscriptionPage(
    result: unknown,
    params: AppServerParams,
    connection: AppServerConnection,
  ): MergedModelCatalogPage;
  list(params: AppServerParams, connection: AppServerConnection): ModelCatalogPage;
}
