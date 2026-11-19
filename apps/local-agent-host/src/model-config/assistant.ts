import { assertModelPolicy } from "@opencraft/model-usage-policy";
import type { PersonalAssistantModelSelection } from "@opencraft/appserver-protocol";
import { createEngineModelSource, EngineModelError, type EngineModelRoute } from "./engine-models.js";
import { createAssistantModelGateway, type AssistantModelContext } from "./assistant-gateway.js";
import type { AssistantModelPurpose } from "./assistant-admission.js";
import { proxyProviderUrl, readProxyCaller, type ProxyCaller } from "./service.js";

const NATIVE_EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh"];
// Stable native default, restricted to levels explicitly declared by this model.
const DEFAULT_EFFORTS = ["medium", "low", "minimal", "high", "xhigh", "off"] as const;

/** Installation model repository is the sole connection/credential owner. No Bot files receive keys.
 *  Every connection is reached through a loopback gateway that coordinates capacity and translates Anthropic
 *  Messages per request; native Codex holds only the gateway token, never the provider credential. */
/** OPENCRAFT_ASSISTANT_PROXY_CALLER_FILE names the assistant's caller record when the model proxy runs as its own
 *  service. A dedicated name keeps it from leaking into engines spawned by the same process. */
const assistantProxyCaller = () =>
  readProxyCaller({ OPENCRAFT_PROXY_CALLER_FILE: process.env.OPENCRAFT_ASSISTANT_PROXY_CALLER_FILE });
export function createAssistantModelSource(
  directory: string,
  policyPath?: string,
  options: { fetch?: typeof fetch; proxyCaller?: () => ProxyCaller | null } = {},
) {
  const proxyCaller = options.proxyCaller ?? assistantProxyCaller;
  const source = createEngineModelSource(directory, {
    protocols: ["openai-responses", "anthropic-messages"],
    meteredContributions: true,
  });
  // Only declared native Codex reasoning levels are projected. No model-name inference.
  function effortFor(route: EngineModelRoute) {
    const declared = route.model.reasoningEfforts;
    const level =
      route.defaultReasoningEffort ??
      (declared ? DEFAULT_EFFORTS.find((candidate) => Object.hasOwn(declared, candidate)) : undefined);
    // Do not invent support or silently replace an explicit installation default.
    if (declared && (level === undefined || !Object.hasOwn(declared, level)))
      throw Error("assistant_model_unavailable");
    const effort = declared === false || level === "off" ? "none" : level;
    if (effort !== undefined && !NATIVE_EFFORTS.includes(effort)) throw Error("assistant_model_unavailable");
    assertModelPolicy(policyPath, "codex", route.model.id, effort);
    assertModelPolicy(
      policyPath,
      "codex",
      "configured/" + encodeURIComponent(route.provider.id) + "/" + encodeURIComponent(route.model.id),
      effort,
    );
    return effort;
  }
  async function route(selection: PersonalAssistantModelSelection) {
    try {
      return await source.resolve(selection);
    } catch (error) {
      throw Error(
        error instanceof EngineModelError && error.code === "changed"
          ? "assistant_model_changed"
          : "assistant_model_unavailable",
      );
    }
  }
  const gateway = createAssistantModelGateway(async (reference) => {
    const current = await route(reference);
    effortFor(current);
    // With the proxy service, provider credentials stay in the proxy; the request carries only the caller token.
    // The record is read per request so a proxy restart's new token is used. Capacity stays keyed by the provider.
    const caller = proxyCaller(),
      proxied = caller ? proxyProviderUrl(current.provider, caller) : null;
    return {
      baseUrl: proxied ?? current.baseUrl,
      model: current.model.id,
      apiKey: proxied ? caller!.token : current.apiKey,
      protocol: current.protocol,
      reasoningEfforts: current.model.reasoningEfforts,
      maxTokens: current.model.maxTokens,
      quotaKey: JSON.stringify([
        new URL(current.baseUrl).origin,
        current.provider.credentialRef
          ? ["credential", current.provider.credentialRef]
          : ["connection", current.provider.id],
      ]),
    };
  }, options);
  async function resolve(selection: PersonalAssistantModelSelection, context: AssistantModelContext = {}) {
    const current = await route(selection),
      effort = effortFor(current),
      reasoning = effort === undefined ? {} : { reasoningEffort: effort };
    return { ...(await gateway.connection(selection, context)), ...reasoning };
  }
  return {
    resolve,
    activity: (scope: string) => gateway.activity(scope),
    failure: (scope: string, purpose: AssistantModelPurpose) => gateway.failure(scope, purpose),
    async catalog() {
      let routes: EngineModelRoute[];
      try {
        routes = await source.list();
      } catch {
        routes = await source.list();
      }
      const models = [];
      for (const route of routes) {
        try {
          effortFor(route);
        } catch {
          continue; /* Policy-denied or unprojectable; do not explain why. */
        }
        models.push({
          providerId: route.provider.id,
          modelId: route.model.id,
          label: route.provider.name + " · " + (route.model.name ?? route.model.id),
        });
      }
      return { models, available: true };
    },
    close: () => gateway.close(),
  };
}
