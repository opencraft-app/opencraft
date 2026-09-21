import { Context, Service } from "@deepseek-ai/cordis";
import { modelMetadata } from "../generated/model-metadata.ts";
import type {
  ModelInputRecord,
  ModelMetadataPort,
  ModelMetadataRecord,
} from "../types/model-metadata.ts";

export class ModelMetadataService extends Service implements ModelMetadataPort {
  private readonly byRoute = new Map<string, ModelMetadataRecord>();
  private readonly byModel = new Map<string, ModelMetadataRecord[]>();

  constructor(ctx: Context) {
    super(ctx, "modelMetadata");
    for (const record of modelMetadata) {
      this.byRoute.set(`${record.provider}\0${record.id}`, record);
      const values = this.byModel.get(record.id) ?? [];
      values.push(record);
      this.byModel.set(record.id, values);
    }
  }

  resolve(provider: string | null | undefined, model: string): ModelMetadataRecord | null {
    if (provider) return this.byRoute.get(`${provider}\0${model}`) ?? null;
    const matches = this.byModel.get(model) ?? [];
    return matches.length === 1 ? matches[0] ?? null : null;
  }

  inputModalities(model: string, provider: string | null = null): string[] {
    const matches = provider
      ? [this.resolve(provider, model)].filter((record): record is ModelMetadataRecord => record !== null)
      : (this.byModel.get(model) ?? []);
    if (matches.length === 0) return ["text"];
    return [...new Set(matches.flatMap((record) => (
      record.input.length > 0 ? record.input : ["text"]
    )))];
  }

  inputModalitiesForRecord(record: ModelInputRecord = {}): string[] {
    if (Array.isArray(record.inputModalities) && record.inputModalities.length > 0) {
      return [...new Set(record.inputModalities.map(String))];
    }
    return this.inputModalities(record.model ?? "", record.metadataProvider ?? null);
  }

  supportsRecordInput(record: ModelInputRecord, modality: string): boolean {
    return this.inputModalitiesForRecord(record).includes(modality);
  }

  supportsInput(model: string, modality: string, provider: string | null = null): boolean {
    return this.inputModalities(model, provider).includes(modality);
  }

  providers(): string[] {
    return [...new Set(modelMetadata.map((record) => record.provider))];
  }
}
