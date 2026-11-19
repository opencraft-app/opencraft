import { randomUUID, createHash } from "node:crypto";
import { ModelGatewayError, ModelGatewayStore } from "@opencraft/account-pool-host";
import { ModelConfigurationRepository, ModelCredentialRepository } from "./repository.js";

/** A contribution reuses Model Services' credential owner. The gateway ledger
 * stores only ownership/consent, never a second copy of a key. */
export function gatewayContributions(directory: string, path: string) {
  const models = new ModelConfigurationRepository(directory),
    credentials = new ModelCredentialRepository(directory);
  return {
    async directory(actor: string) {
      const current = await models.read(),
        store = new ModelGatewayStore(path);
      try {
        return current.providers
          .filter((provider) => store.canUse(provider.id, actor))
          .map((provider) => {
            const key = store.contribution(provider.id);
            return {
              id: provider.id,
              name: provider.name,
              baseUrl: provider.baseUrl,
              protocol: provider.protocol,
              enabled: provider.enabled,
              owned: key?.actor === actor,
              scope: key?.scope ?? "team",
              revision: key?.revision ?? 0,
              kind:
                provider.catalogId === "opencraft-human-subscription" ? "subscription" : key ? "api-key" : "platform",
              template:
                !provider.catalogId?.startsWith("opencraft-human-") &&
                ["openai-responses", "anthropic-messages"].includes(provider.protocol),
              models: provider.models
                .filter((model) => model.type !== "asr")
                .map((model) => ({ id: model.id, name: model.name ?? model.id, enabled: model.enabled })),
            };
          });
      } finally {
        store.close();
      }
    },
    async contribute(actor: string, input: Record<string, unknown>, assertCurrent: () => void = () => {}) {
      const { name, baseUrl, protocol, model, apiKey } = input;
      const scope = input.scope ?? (input.shareWithTeam === true ? "team" : "personal");
      if (
        !["personal", "team"].includes(String(scope)) ||
        (input.shareWithTeam !== undefined && typeof input.shareWithTeam !== "boolean") ||
        (scope === "team" && input.shareWithTeam !== true) ||
        (scope === "personal" && input.shareWithTeam === true) ||
        typeof name !== "string" ||
        !name.trim() ||
        name.length > 128 ||
        typeof baseUrl !== "string" ||
        typeof model !== "string" ||
        !/^[A-Za-z0-9_.:/-]{1,160}$/u.test(model) ||
        typeof apiKey !== "string" ||
        !apiKey ||
        apiKey.length > 8192 ||
        /\s/u.test(apiKey) ||
        !["openai-responses", "anthropic-messages"].includes(String(protocol))
      )
        throw new ModelGatewayError("invalid_gateway_contribution", 400);
      let url: URL;
      try {
        url = new URL(baseUrl);
      } catch {
        throw new ModelGatewayError("invalid_gateway_endpoint", 400);
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        /\/(responses|chat\/completions|messages|models)\/?$/u.test(url.pathname)
      )
        throw new ModelGatewayError("invalid_gateway_endpoint", 400);
      const provider = "byok-" + randomUUID(),
        ref = "GATEWAY_" + randomUUID().replaceAll("-", "");
      const store = new ModelGatewayStore(path);
      try {
        const current = await models.read();
        // Humans supply a key for an administrator-declared service. They do
        // not gain the administrator's permission to create arbitrary egress.
        const approved = current.providers.find(
          (p) =>
            !p.catalogId?.startsWith("opencraft-human-") &&
            p.protocol === protocol &&
            p.baseUrl.replace(/\/$/u, "") === url.toString().replace(/\/$/u, "") &&
            p.models.some((m) => m.id === model && m.type !== "asr"),
        );
        if (!approved) throw new ModelGatewayError("gateway_endpoint_not_approved", 403);
        const declaration = approved.models.find((m) => m.id === model)!;
        assertCurrent();
        // A crash at any intermediate step leaves a non-selectable contribution.
        // No uncertain cross-store write is retried or garbage-collected here.
        store.prepareContribution(provider, actor, approved.id, scope as "personal" | "team");
        await credentials.set(ref, apiKey);
        assertCurrent();
        await models.update(current.revision, (draft) => {
          assertCurrent();
          draft.providers.push({
            id: provider,
            name: name.trim(),
            catalogId: "opencraft-human-contribution",
            protocol: String(protocol),
            baseUrl: url.toString().replace(/\/$/u, ""),
            credentialRef: ref,
            enabled: true,
            models: [{ ...declaration, enabled: true }],
          });
        });
        assertCurrent();
        store.contributionState(provider, actor, "shared");
        return { providerId: provider, modelId: model, scope, shared: scope === "team" };
      } finally {
        store.close();
      }
    },
    async connectSubscription(actor: string, descriptor: unknown, assertCurrent: () => void) {
      const value = descriptor as {
        providerId: string;
        baseUrl: string;
        proxyToken: string;
        models: { id: string; name?: string; enabled: boolean }[];
      };
      const namespace = createHash("sha256").update(actor).digest("hex"),
        provider = "subscription-" + namespace;
      const url = new URL(value.baseUrl);
      if (
        value.providerId !== provider ||
        url.protocol !== "http:" ||
        url.hostname !== "127.0.0.1" ||
        url.pathname !== "/personal/" + namespace + "/v1" ||
        url.search ||
        url.hash ||
        url.username ||
        url.password ||
        typeof value.proxyToken !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/.test(value.proxyToken) ||
        !Array.isArray(value.models) ||
        !value.models.length ||
        value.models.length > 512
      )
        throw new ModelGatewayError("invalid_subscription_connection", 503);
      const store = new ModelGatewayStore(path),
        ref = "GATEWAY_SUBSCRIPTION_" + namespace.toUpperCase();
      try {
        assertCurrent();
        const key = store.contribution(provider);
        if (key && (key.actor !== actor || key.templateProvider !== "codex-subscription"))
          throw new ModelGatewayError("gateway_contribution_forbidden", 403);
        if (!key) store.prepareContribution(provider, actor, "codex-subscription", "personal");
        else if (key.state === "withdrawn") store.reconnectContribution(provider, actor);
        const current = await models.read();
        await credentials.set(ref, value.proxyToken);
        assertCurrent();
        await models.update(current.revision, (draft) => {
          assertCurrent();
          draft.providers = draft.providers
            .filter((p) => p.id !== provider)
            .concat({
              id: provider,
              name: "我的 Codex 订阅",
              catalogId: "opencraft-human-subscription",
              protocol: "openai-responses",
              baseUrl: value.baseUrl,
              credentialRef: ref,
              enabled: true,
              models: value.models.map((m) => ({ id: m.id, name: m.name ?? m.id, enabled: true })),
            });
        });
        assertCurrent();
        if (store.contribution(provider)?.state === "preparing") store.contributionState(provider, actor, "shared");
        return { providerId: provider, scope: "personal", kind: "subscription" };
      } finally {
        store.close();
      }
    },
    async withdraw(actor: string, provider: string) {
      const store = new ModelGatewayStore(path);
      try {
        store.contributionState(provider, actor, "withdrawn");
        const current = await models.read();
        await models.update(current.revision, (draft) => {
          const entry = draft.providers.find((p) => p.id === provider);
          if (entry) entry.enabled = false;
          if (draft.defaultModel?.providerId === provider) draft.defaultModel = null;
        });
        return { withdrawn: true };
      } finally {
        store.close();
      }
    },
  };
}
