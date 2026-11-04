import type { IncomingMessage, ServerResponse } from 'node:http';
import { POLICY_PATH, ModelPolicyStore, parseRules } from './index.js';
export function modelPolicyHttp(store:ModelPolicyStore, authority:(request:IncomingMessage)=>{actor:string;administrator:boolean;origin:string|null}|null) {
  return async (request:IncomingMessage,response:ServerResponse) => {
    const url=new URL(request.url ?? '/', 'http://policy.invalid');
    if(url.pathname!==POLICY_PATH) return false;
    const send=(status:number,value:unknown)=>{response.writeHead(status,{'content-type':'application/json','cache-control':'private, no-store'});response.end(JSON.stringify(value));};
    let access=authority(request);
    if(!access) {send(403,{error:'administrator_required'});return true;}
    if(request.method==='GET') {
      send(200,access.administrator ? {canManage:true,...store.read(),audit:store.audit()} : {canManage:false});return true;
    }
    if(!access.administrator){send(403,{error:'administrator_required'});return true;}
    if(request.method!=='POST'){send(405,{error:'method_not_allowed'});return true;}
    try {
      const origin=request.headers.origin;
      if(typeof origin!=='string'||!(origin===access.origin||['http:','https:'].some(s=>origin===s+'//'+request.headers.host))||request.headers['sec-fetch-site']==='cross-site'||request.headers['content-type']?.split(';')[0]!=='application/json') throw Error('same_origin_required');
      let size=0;const chunks:Buffer[]=[];
      for await(const chunk of request){size+=Buffer.byteLength(chunk);if(size>131072)throw Error('invalid_model_policy');chunks.push(Buffer.from(chunk));}
      const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if(!body||Object.keys(body).some(k=>!['revision','rules'].includes(k)))throw Error('invalid_model_policy');
      const rules=parseRules(body.rules); const latest=authority(request);
      if(!latest?.administrator||latest.actor!==access.actor)throw Error('administrator_required');
      send(200,{canManage:true,...store.write(body.revision,rules,latest.actor),audit:store.audit()});
    }catch(error){const code=error instanceof Error ? error.message:'invalid_model_policy';send(code==='revision_conflict'?409:code==='administrator_required'||code==='same_origin_required'?403:400,{error:code});}
    return true;
  };
}
