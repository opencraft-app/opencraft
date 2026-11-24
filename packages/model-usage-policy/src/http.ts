import { HttpBodyTooLarge, decodeUtf8, jsonResponse, requestUrl, type HttpExchangeRequest, type HttpExchangeResponse, type HttpRequestView } from '@opencraft/http-exchange';
import { POLICY_PATH, ModelPolicyStore, parseRules } from './index.js';
/** Runtime-neutral exchange handler; `authority` receives the transport's request view. */
export function modelPolicyHttp<R = HttpRequestView>(store:ModelPolicyStore, authority:(request:R)=>{actor:string;administrator:boolean;origin:string|null}|null) {
  return async (exchange:HttpExchangeRequest<R>):Promise<HttpExchangeResponse|null> => {
    const url=requestUrl(exchange);
    if(url.pathname!==POLICY_PATH) return null;
    const request=exchange.identity;
    const send=(status:number,value:unknown)=>jsonResponse(status,value,[['content-type','application/json'],['cache-control','private, no-store']]);
    let access=authority(request);
    if(!access) return send(403,{error:'administrator_required'});
    if(exchange.method==='GET') return send(200,access.administrator ? {canManage:true,...store.read(),audit:store.audit()} : {canManage:false});
    if(!access.administrator) return send(403,{error:'administrator_required'});
    if(exchange.method!=='POST') return send(405,{error:'method_not_allowed'});
    try {
      const origin=exchange.headers.origin;
      if(typeof origin!=='string'||!(origin===access.origin||['http:','https:'].some(s=>origin===s+'//'+exchange.headers.host))||exchange.headers['sec-fetch-site']==='cross-site'||exchange.headers['content-type']?.split(';')[0]!=='application/json') throw Error('same_origin_required');
      let bytes:Uint8Array;
      try{bytes=await exchange.readBody(131072);}catch(error){if(error instanceof HttpBodyTooLarge)throw Error('invalid_model_policy');throw error;}
      const body=JSON.parse(decodeUtf8(bytes));
      if(!body||Object.keys(body).some(k=>!['revision','rules'].includes(k)))throw Error('invalid_model_policy');
      const rules=parseRules(body.rules); const latest=authority(request);
      if(!latest?.administrator||latest.actor!==access.actor)throw Error('administrator_required');
      return send(200,{canManage:true,...store.write(body.revision,rules,latest.actor),audit:store.audit()});
    }catch(error){const code=error instanceof Error ? error.message:'invalid_model_policy';return send(code==='revision_conflict'?409:code==='administrator_required'||code==='same_origin_required'?403:400,{error:code});}
  };
}
