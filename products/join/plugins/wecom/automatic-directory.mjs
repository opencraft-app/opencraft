import { createRtxDirectoryResolver, normalizeRtx } from '../tencentoa/src/rtx-directory.mjs';
import { humanKey } from './mirror/store.mjs';

/** Resolve Join's signed WeCom directory ID to its employee account first.
 * Reuse verified OA claims to resolve the canonical subject; do not create or
 * merge Actors. The existing Relay selector remains the membership authority. */
export function createAutomaticDirectory(redis, corpId, listServers, resolveSender=async(_source,id)=>id) {
  const resolveIdentity = createRtxDirectoryResolver(redis);
  return async (job,source)=>{
    const account=await resolveSender(source,job.userId);
    const login=normalizeRtx(account);
    if(!login)return {servers:[],history:[],unresolved:true};
    const human=humanKey(corpId,login),key='wecom-directory:v1:identity:'+human;
    const resolved=await resolveIdentity(login,key);
    if(resolved.state!=='resolved')return {servers:[],history:[],unresolved:true};
    const identity=resolved.identity;
    // This short principal is attested by the signed callback, not by a reused
    // browser token. It is only passed to the trusted read-only directory port.
    const current=await listServers({...identity,expiresAt:Date.now()+60000});
    const historyKey='wecom-directory:v1:participation:'+human,now=Date.now();
    const history=JSON.parse(await redis.evaluate(`local records=cjson.decode(redis.call('GET',KEYS[1]) or '{}');local servers=cjson.decode(ARGV[1]);for _,server in ipairs(servers) do local old=records[server.id];records[server.id]={id=server.id,name=server.name,firstConfirmedAt=old and old.firstConfirmedAt or tonumber(ARGV[2]),lastConfirmedAt=tonumber(ARGV[2])} end;redis.call('SET',KEYS[1],cjson.encode(records));local out={};for _,server in ipairs(servers) do table.insert(out,records[server.id]) end;return cjson.encode(out)`,[historyKey],[JSON.stringify(current.servers),now]));
    return {...current,history:Array.isArray(history)?history:[]};
  };
}
