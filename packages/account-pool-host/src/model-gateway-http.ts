import { HttpBodyTooLarge, decodeUtf8, jsonResponse, requestUrl, type HttpExchangeRequest, type HttpExchangeResponse, type HttpRequestView } from "@opencraft/http-exchange";
import { ModelGatewayError, ModelGatewayStore } from "./model-gateway-store.js";

export const MODEL_GATEWAY_PATH = "/__opencraft_model_gateway";
export interface GatewayHuman { actor: string; administrator: boolean; origin: string | null }

/** Human identity and current administrator status come exclusively from the
 * product's existing identity authority. No body/header can select a payer. */
export function modelGatewayHttp<R = HttpRequestView>(options: {
  path: string;
  authority(request: R): GatewayHuman | null;
  contribute?(actor: string, input: Record<string, unknown>, assertCurrent?:()=>void): Promise<unknown>;
  withdraw?(actor: string, provider: string): Promise<unknown>;
  directory?(actor: string): Promise<unknown>;
  subscription?(actor:string, input:Record<string,unknown>, assertCurrent:()=>void):Promise<unknown>;
}) {
  return async (exchange: HttpExchangeRequest<R>): Promise<HttpExchangeResponse | null> => {
    const url = requestUrl(exchange);
    if (url.pathname !== MODEL_GATEWAY_PATH) return null;
    const request = exchange.identity;
    let reply: HttpExchangeResponse | undefined;
    const send = (status: number, value: unknown) => { reply = jsonResponse(status, value, [["content-type", "application/json"], ["cache-control", "private, no-store"]]); };
    let store: ModelGatewayStore | undefined;
    try {
      const identity = options.authority(request);
      if (!identity) throw new ModelGatewayError("gateway_human_required", 403);
      store = new ModelGatewayStore(options.path);
      if (exchange.method === "GET") {
        const actor = url.searchParams.get("actor") ?? identity.actor;
        if (actor !== identity.actor && !identity.administrator) throw new ModelGatewayError("gateway_forbidden", 403);
        const directory=options.directory ? await options.directory(actor):undefined;
        const current=options.authority(request);
        if(!current || current.actor!==identity.actor || current.administrator!==identity.administrator)throw new ModelGatewayError("gateway_identity_changed",403);
        send(200, { ...store.summary(actor), subscriptionAvailable: !!options.subscription, canManage: identity.administrator, requests: store.requests(actor), contributions: store.contributions(actor), directory });
        return reply!;
      }
      if (exchange.method !== "POST") throw new ModelGatewayError("method_not_allowed", 405);
      if (!identity.origin || exchange.headers.origin !== identity.origin || exchange.headers["sec-fetch-site"] === "cross-site"
        || exchange.headers["content-type"]?.split(";")[0] !== "application/json") throw new ModelGatewayError("same_origin_required", 403);
      let bytes: Uint8Array;
      try { bytes = await exchange.readBody(32768); }
      catch (error) { if (error instanceof HttpBodyTooLarge) throw new ModelGatewayError("gateway_request_too_large", 413); throw error; }
      const body = JSON.parse(decodeUtf8(bytes));
      if (!body || typeof body !== "object" || Array.isArray(body)) throw new ModelGatewayError("invalid_gateway_request", 400);
      const latest = options.authority(request);
      if (!latest || latest.actor !== identity.actor || latest.administrator !== identity.administrator) throw new ModelGatewayError("gateway_identity_changed", 403);
      const fields = (allowed: string[]) => { if (Object.keys(body).some(key => !allowed.includes(key))) throw new ModelGatewayError("invalid_gateway_request", 400); };
      if (body.action === "configure" && latest.administrator) {
        fields(["action", "actor", "monthlyTokens", "requestTokens", "concurrency", "revision"]);
        send(200, store.configure(body.actor, body, body.revision, latest.actor));
      } else if (body.action === "reconcile" && latest.administrator) {
        fields(["action", "requestId", "actualTokens", "reason"]);
        store.reconcile(body.requestId, body.actualTokens, latest.actor, body.reason);
        send(200, { reconciled: true });
      } else if (body.action === 'subscription' && options.subscription) {
        fields(['action','operation','sessionId']);
        if(!['start','poll','cancel'].includes(body.operation)||body.operation!=='start'&&(typeof body.sessionId!=='string'||body.sessionId.length>128))throw new ModelGatewayError('invalid_subscription_request',400);
        const assertCurrent=()=>{const current=options.authority(request);if(!current||current.actor!==latest.actor)throw new ModelGatewayError('gateway_identity_changed',403);};
        const result=await options.subscription(latest.actor,body,assertCurrent);assertCurrent();send(200,result);
      } else if (body.action === "contribute" && options.contribute) {
        fields(["action", "name", "baseUrl", "protocol", "model", "apiKey", "shareWithTeam", "scope"]);
        if (body.scope === "team" && body.shareWithTeam !== true) throw new ModelGatewayError("gateway_sharing_consent_required", 400);
        send(200, await options.contribute(latest.actor, body,()=>{
          const current=options.authority(request);
          if(!current||current.actor!==latest.actor)throw new ModelGatewayError("gateway_identity_changed",403);
        }));
      } else if (body.action === "personalLimit") {
        fields(["action","monthlyTokens","revision"]);
        send(200,store.setPersonalLimit(latest.actor,body.monthlyTokens,body.revision));
      } else if (body.action === "scope") {
        fields(["action","provider","scope","revision","shareWithTeam"]);
        if(body.scope==="team" && body.shareWithTeam!==true)throw new ModelGatewayError("gateway_sharing_consent_required",400);
        if(body.scope==="personal" && body.shareWithTeam===true)throw new ModelGatewayError("invalid_gateway_scope",400);
        send(200,store.setScope(body.provider,latest.actor,body.scope,body.revision));
      } else if (body.action === "withdraw" && options.withdraw) {
        fields(["action", "provider"]);
        send(200, await options.withdraw(latest.actor, body.provider));
      } else throw new ModelGatewayError("gateway_operation_forbidden", 403);
    } catch (error) {
      const known = error instanceof ModelGatewayError;
      send(known ? error.status : error instanceof SyntaxError ? 400 : 503,
        { error: known ? error.kind : error instanceof SyntaxError ? "invalid_gateway_request" : "gateway_unavailable" });
    } finally { store?.close(); }
    return reply!;
  };
}
