import { createHmac, randomBytes } from "node:crypto";
import { ModelConfigurationRepository, ModelCredentialRepository } from "./repository.js";
import type { ModelDocument } from "./model-document.js";

export const HUNYUAN_SPEECH = Object.freeze({ api: "hunyuan-asr" as const,
  baseURL: "https://tokenhub.tencentmaas.com/v1/wand/asrproxy", model: "ep-hyasr3" });

export function isHunyuanSpeechEndpoint(value: string) {
  return value.replace(/\/+$/u, "") === HUNYUAN_SPEECH.baseURL;
}

/** Installation-scoped reader/writer over the SAME repositories as Model Services. */
export class SpeechModelConfiguration {
  private readonly bindingKey = randomBytes(32);
  constructor(readonly repository: ModelConfigurationRepository, readonly credentials: ModelCredentialRepository) {}

  async read() {
    // A model commit and credential commit use separate files. Do not expose a torn binding.
    for (let attempt = 0; attempt < 3; attempt++) {
      const before = await this.credentials.stamp();
      const doc = await this.repository.read();
      const selection = doc.defaultSpeechModel ?? null;
      const provider = doc.providers.find(p => p.id === selection?.providerId);
      const model = provider?.models.find(m => m.id === selection?.modelId);
      const apiKey = provider?.credentialRef ? await this.credentials.resolve(provider.credentialRef) : undefined;
      if (before !== await this.credentials.stamp() || doc.revision !== (await this.repository.read()).revision) continue;
      const available = !!(provider?.enabled && provider.protocol === HUNYUAN_SPEECH.api
        && isHunyuanSpeechEndpoint(provider.baseUrl) && model?.enabled && model.type === "asr"
        && /^[a-zA-Z0-9._-]{1,100}$/u.test(model.id) && apiKey?.trim() && !/[\r\n\0]/u.test(apiKey));
      // HMAC prevents exposing a credential hash or allowing an offline key oracle.
      const binding = available ? createHmac("sha256", this.bindingKey)
        .update(JSON.stringify([provider!.id, provider!.baseUrl, model!.id, provider!.credentialRef, apiKey])).digest("hex") : null;
      return { revision: doc.revision, selection, binding, models: this.models(doc),
        config: available ? { apiKey: apiKey!, model: model!.id, binding: binding! } : null };
    }
    throw new Error("语音配置正在更新，请刷新后重试");
  }

  private models(doc: ModelDocument) {
    return doc.providers.filter(p => p.protocol === HUNYUAN_SPEECH.api).flatMap(p => p.models.filter(m => m.type === "asr")
      .map(m => ({ providerId: p.id, modelId: m.id, name: `${p.name} · ${m.name ?? m.id}`, enabled: p.enabled && m.enabled })));
  }

  async select(expectedRevision: number, selection: ModelDocument["defaultSpeechModel"]) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || selection === undefined
      || (selection !== null && (typeof selection !== "object" || Array.isArray(selection)
        || Object.keys(selection).some(k => k !== "providerId" && k !== "modelId")
        || typeof selection.providerId !== "string" || typeof selection.modelId !== "string"))) throw new Error("语音模型选择无效");
    await this.repository.update(expectedRevision, doc => {
      if (selection) {
        const provider = doc.providers.find(p => p.id === selection.providerId);
        if (!provider?.enabled || provider.protocol !== HUNYUAN_SPEECH.api || !isHunyuanSpeechEndpoint(provider.baseUrl)
          || !provider.models.some(m => m.id === selection.modelId && m.type === "asr" && m.enabled)) throw new Error("请先在模型服务中启用语音模型");
      }
      doc.defaultSpeechModel = selection;
    });
  }
}
