export interface ModelMetadataRecord {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly contextWindow: number;
  readonly maxTokens: number;
  readonly input: readonly string[];
}

export interface ModelInputRecord extends Record<string, unknown> {
  model?: string | null;
  metadataProvider?: string | null;
  inputModalities?: readonly unknown[];
}

export interface ModelMetadataPort {
  resolve(provider: string | null | undefined, model: string): ModelMetadataRecord | null;
  inputModalities(model: string, provider?: string | null): string[];
  inputModalitiesForRecord(record?: ModelInputRecord): string[];
  supportsRecordInput(record: ModelInputRecord, modality: string): boolean;
  supportsInput(model: string, modality: string, provider?: string | null): boolean;
  providers(): string[];
}
