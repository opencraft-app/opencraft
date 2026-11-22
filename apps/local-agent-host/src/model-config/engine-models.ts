import { fileStateDocumentStore } from "@opencraft/document-storage/state-file";
import { configuredModelGatewayPath, ModelGatewayStore } from "@opencraft/account-pool-host";
import { createHash } from 'node:crypto';
import { ModelConfigurationRepository, ModelCredentialRepository } from "./repository.js";
import { fileSecretStore } from "@opencraft/secret-storage/file";
import { engineEndpointAllowed } from "./engine-endpoint.js";
export { engineEndpointAllowed, localNetworkHost } from "./engine-endpoint.js";
import type { ConfiguredModel, ConfiguredProvider, ModelDocument } from "./model-document.js";

/** Chat wire protocols an engine adapter can carry. Each consumer declares its own subset. */
export type EngineModelProtocol = "openai-responses" | "anthropic-messages" | "openai-completions";

export interface EngineModelReference { readonly providerId: string; readonly modelId: string }

export interface EngineModelRoute {
  readonly provider: ConfiguredProvider;
  readonly model: ConfiguredModel;
  readonly protocol: EngineModelProtocol;
  readonly baseUrl: string;
  /** Absent only for providers declared `authentication: "none"`. */
  readonly apiKey?: string;
  /** Product default reasoning choice when this model is the installation default. */
  readonly defaultReasoningEffort?: string;
}

/** `unavailable`: not selectable (disabled, removed, protocol or endpoint).
 *  `credential`: selectable connection whose required key is missing or malformed.
 *  `changed`: the document moved while a credential was being read; retry from a fresh read. */
export type EngineModelErrorCode = "unavailable" | "credential" | "changed";
export class EngineModelError extends Error {
  constructor(readonly code: EngineModelErrorCode) {
    super(code === "changed" ? "Model configuration changed" : code === "credential" ? "Model credential is unavailable" : "Model is unavailable");
  }
}

const MODEL_ID = /^[A-Za-z0-9_.:/-]{1,160}$/u;
function eligible(provider: ConfiguredProvider, model: ConfiguredModel, protocols: readonly EngineModelProtocol[], allowInsecureLocalNetwork: boolean): boolean {
  return provider.enabled && (protocols as readonly string[]).includes(provider.protocol) && !!provider.baseUrl
    && engineEndpointAllowed(provider.baseUrl, allowInsecureLocalNetwork) && model.enabled && model.type !== "asr" && MODEL_ID.test(model.id);
}

/**
 * Single read-only resolver over the installation model owners (Model Services).
 * Engines never copy endpoints or keys into their own stores; every execution resolves again.
 */
export function createEngineModelSource(directory: string, options: { readonly protocols: readonly EngineModelProtocol[]; readonly meteredContributions?: boolean; readonly allowInsecureLocalNetwork?: boolean }) {
  const repository = new ModelConfigurationRepository(fileStateDocumentStore(directory)), credentials = new ModelCredentialRepository(fileSecretStore(directory));

  async function route(document: ModelDocument, provider: ConfiguredProvider, model: ConfiguredModel): Promise<EngineModelRoute> {
    if (!eligible(provider, model, options.protocols, options.allowInsecureLocalNetwork === true)) throw new EngineModelError("unavailable");
    if (provider.catalogId === "opencraft-human-contribution" || provider.catalogId === "opencraft-human-subscription") {
      if (!options.meteredContributions) throw new EngineModelError("unavailable");
      const path = configuredModelGatewayPath();
      if (!path) throw new EngineModelError("unavailable");
      const gateway = new ModelGatewayStore(path);
      try {
        const contribution = gateway.contribution(provider.id);
        const template = document.providers.find(p => p.id === contribution?.templateProvider);
        if (provider.catalogId === "opencraft-human-subscription") {
          if (contribution?.state !== "shared" || contribution.templateProvider !== "codex-subscription" || contribution.scope !== "personal" || provider.protocol !== "openai-responses" || !/^http:\/\/127\.0\.0\.1:[0-9]+\/personal\/[a-f0-9]{64}\/v1$/.test(provider.baseUrl)) throw new EngineModelError("unavailable");
          const namespace=createHash('sha256').update(contribution.actor).digest('hex');
          if(provider.id!=='subscription-'+namespace||new URL(provider.baseUrl).pathname!=='/personal/'+namespace+'/v1')throw new EngineModelError('unavailable');
        } else
        if (contribution?.state !== "shared" || !template || template.protocol !== provider.protocol
          || template.baseUrl.replace(/\/$/u, "") !== provider.baseUrl.replace(/\/$/u, "")
          || !template.models.some(m => m.id === model.id && m.type !== "asr")) throw new EngineModelError("unavailable");
      }
      finally { gateway.close(); }
    }
    let apiKey: string | undefined;
    if (provider.authentication !== "none") {
      apiKey = provider.credentialRef ? await credentials.resolve(provider.credentialRef) : undefined;
      if (!apiKey || /\s/u.test(apiKey)) throw new EngineModelError("credential");
    }
    // Never pair an edited endpoint with the previous connection's credential.
    if ((await repository.read()).revision !== document.revision) throw new EngineModelError("changed");
    const preferred = document.defaultModel;
    const defaultReasoningEffort = preferred?.providerId === provider.id && preferred.modelId === model.id ? preferred.reasoningEffort : undefined;
    return { provider, model, protocol: provider.protocol as EngineModelProtocol, baseUrl: provider.baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }), ...(defaultReasoningEffort === undefined ? {} : { defaultReasoningEffort }) };
  }

  return {
    /** Throws EngineModelError; never falls back to another connection or model. */
    async resolve(reference: EngineModelReference): Promise<EngineModelRoute> {
      const document = await repository.read();
      const provider = document.providers.find(p => p.id === reference.providerId);
      const model = provider?.models.find(m => m.id === reference.modelId);
      if (!provider || !model) throw new EngineModelError("unavailable");
      return route(document, provider, model);
    },
    /** Selectable routes from one consistent document. Unselectable entries are omitted, not explained. */
    async list(): Promise<EngineModelRoute[]> {
      const document = await repository.read(), routes: EngineModelRoute[] = [];
      for (const provider of document.providers) for (const model of provider.models) {
        try { routes.push(await route(document, provider, model)); }
        catch (error) { if (error instanceof EngineModelError && error.code !== "changed") continue; throw error; }
      }
      return routes;
    },
  };
}

/** The account Core's model credential owner over the installation credentials file (write and presence only). */
export function fileModelCredentials(directory: string) {
  const credentials = new ModelCredentialRepository(fileSecretStore(directory));
  return { configured: (ref: string) => credentials.configured(ref), set: (ref: string, value: string) => credentials.set(ref, value),
    remove: (ref: string) => credentials.remove(ref) };
}
