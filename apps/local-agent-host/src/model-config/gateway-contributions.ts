// Human contributions to the model gateway (runtime-neutral): a Human's API key
// for an administrator-declared service, or a personal subscription connection.
// Model configuration and credentials arrive as the account's repositories
// (Node: the data directory's `models/` files; AccountCore: the object's state
// documents and sealed secrets); the gateway store is the one the account's
// composition root opened, borrowed and never closed here.
import { randomUUID } from "node:crypto";
import { ModelGatewayError, type ModelGatewayStore } from "@opencraft/account-pool-host/model-gateway";
import type { GatewayAuthorityCheck } from "@opencraft/account-pool-host/model-gateway-http";
import { personalSubscriptionNamespace } from "@opencraft/account-pool-host/personal-subscriptions";
import type { ModelConfigurationRepository, ModelCredentialRepository } from "./repository.js";

/** A contribution reuses Model Services' credential owner. The gateway ledger
 * stores only ownership/consent, never a second copy of a key. */
export function gatewayContributions({ models, credentials, store: gatewayStore }: {
  models: ModelConfigurationRepository;
  credentials: ModelCredentialRepository;
  /** The gateway store the account's composition root opened. */
  store(): ModelGatewayStore;
}) {
  /**
   * Draft callbacks are synchronous: a synchronous authority answers again
   * inside the draft (before anything is written); an asynchronous one also
   * answered just before the update, and its in-draft answer is awaited after it.
   */
  const update = async (revision: number, assertCurrent: GatewayAuthorityCheck, change: Parameters<ModelConfigurationRepository["update"]>[1]) => {
    let pending: void | Promise<void> = undefined;
    await assertCurrent();
    await models.update(revision, draft => { pending = assertCurrent(); change(draft); });
    await pending;
  };
  return {
    async directory(actor: string) {
      const current=await models.read(),store=gatewayStore();
      return current.providers.filter(provider=>store.canUse(provider.id,actor)).map(provider=>{
        const key=store.contribution(provider.id);
        return {id:provider.id,name:provider.name,baseUrl:provider.baseUrl,protocol:provider.protocol,
          enabled:provider.enabled,owned:key?.actor===actor,scope:key?.scope??"team",revision:key?.revision??0,
          kind:provider.catalogId==='opencraft-human-subscription'?'subscription':key?'api-key':'platform',
          template:!provider.catalogId?.startsWith('opencraft-human-') && ["openai-responses","anthropic-messages"].includes(provider.protocol),
          models:provider.models.filter(model=>model.type!=="asr").map(model=>({id:model.id,name:model.name??model.id,enabled:model.enabled}))};
      });
    },
    async contribute(actor: string, input: Record<string, unknown>, assertCurrent:GatewayAuthorityCheck = ()=>{}) {
      const { name, baseUrl, protocol, model, apiKey } = input;
      const scope = input.scope ?? (input.shareWithTeam === true ? "team" : "personal");
      if (!["personal", "team"].includes(String(scope))
        || input.shareWithTeam !== undefined && typeof input.shareWithTeam !== "boolean"
        || scope === "team" && input.shareWithTeam !== true
        || scope === "personal" && input.shareWithTeam === true
        || typeof name !== "string" || !name.trim() || name.length > 128
        || typeof baseUrl !== "string" || typeof model !== "string" || !/^[A-Za-z0-9_.:/-]{1,160}$/u.test(model)
        || typeof apiKey !== "string" || !apiKey || apiKey.length > 8192 || /\s/u.test(apiKey)
        || !["openai-responses", "anthropic-messages"].includes(String(protocol))) throw new ModelGatewayError("invalid_gateway_contribution", 400);
      let url: URL;
      try { url = new URL(baseUrl); } catch { throw new ModelGatewayError("invalid_gateway_endpoint", 400); }
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash
        || /\/(responses|chat\/completions|messages|models)\/?$/u.test(url.pathname)) throw new ModelGatewayError("invalid_gateway_endpoint", 400);
      const provider = "byok-" + randomUUID(), ref = "GATEWAY_" + randomUUID().replaceAll("-", "");
      const store = gatewayStore();
      const current = await models.read();
      // Humans supply a key for an administrator-declared service. They do
      // not gain the administrator's permission to create arbitrary egress.
      const approved = current.providers.find(p => !p.catalogId?.startsWith('opencraft-human-') && p.protocol === protocol
        && p.baseUrl.replace(/\/$/u, "") === url.toString().replace(/\/$/u, "")
        && p.models.some(m => m.id === model && m.type !== "asr"));
      if (!approved) throw new ModelGatewayError("gateway_endpoint_not_approved", 403);
      const declaration = approved.models.find(m => m.id === model)!;
      await assertCurrent();
      // A crash at any intermediate step leaves a non-selectable contribution.
      // No uncertain cross-store write is retried or garbage-collected here.
      store.prepareContribution(provider, actor, approved.id, scope as "personal" | "team");
      await credentials.set(ref, apiKey);
      await update(current.revision, assertCurrent, draft => {draft.providers.push({ id: provider, name: name.trim(), catalogId: "opencraft-human-contribution",
        protocol: String(protocol), baseUrl: url.toString().replace(/\/$/u, ""), credentialRef: ref, enabled: true,
        models: [{ ...declaration, enabled: true }] });});
      await assertCurrent();
      store.contributionState(provider, actor, "shared");
      return { providerId: provider, modelId: model, scope, shared: scope === "team" };
    },
    /** Records a completed personal subscription; where it is served was checked by the subscription implementation. */
    async connectSubscription(actor:string, descriptor:unknown, assertCurrent:GatewayAuthorityCheck) {
      const value=descriptor as {providerId:string;baseUrl:string;proxyToken:string;models:{id:string;name?:string;enabled:boolean}[]};
      const namespace=personalSubscriptionNamespace(actor),provider='subscription-'+namespace;
      let url:URL;
      try{url=new URL(value.baseUrl);}catch{throw new ModelGatewayError('invalid_subscription_connection',503);}
      if(value.providerId!==provider
        || url.search || url.hash || url.username || url.password
        || typeof value.proxyToken!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(value.proxyToken)
        || !Array.isArray(value.models) || !value.models.length || value.models.length>512)throw new ModelGatewayError('invalid_subscription_connection',503);
      const store=gatewayStore(),ref='GATEWAY_SUBSCRIPTION_'+namespace.toUpperCase();
      await assertCurrent();
      const key=store.contribution(provider);
      if(key&&(key.actor!==actor||key.templateProvider!=='codex-subscription'))throw new ModelGatewayError('gateway_contribution_forbidden',403);
      if(!key)store.prepareContribution(provider,actor,'codex-subscription','personal');
      else if(key.state==='withdrawn')store.reconnectContribution(provider,actor);
      const current=await models.read();
      await credentials.set(ref,value.proxyToken);
      await update(current.revision,assertCurrent,draft=>{
        draft.providers=draft.providers.filter(p=>p.id!==provider).concat({id:provider,name:'我的 Codex 订阅',catalogId:'opencraft-human-subscription',
          protocol:'openai-responses',baseUrl:value.baseUrl,credentialRef:ref,enabled:true,models:value.models.map(m=>({id:m.id,name:m.name??m.id,enabled:true}))});
      });
      await assertCurrent();if(store.contribution(provider)?.state==='preparing')store.contributionState(provider,actor,'shared');
      return {providerId:provider,scope:'personal',kind:'subscription'};
    },
    async withdraw(actor: string, provider: string) {
      const store = gatewayStore();
      store.contributionState(provider, actor, "withdrawn");
      const current = await models.read();
      await models.update(current.revision, draft => {
        const entry = draft.providers.find(p => p.id === provider);
        if (entry) entry.enabled = false;
        if (draft.defaultModel?.providerId === provider) draft.defaultModel = null;
      });
      return { withdrawn: true };
    },
  };
}
