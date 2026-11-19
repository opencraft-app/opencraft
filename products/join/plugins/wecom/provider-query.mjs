/** Installation-owned async provider reads. No credentials or owner selectors reach agents. */
const readers=new Map();
export function installProviderReader(corpId,read) {
  const entry={read};readers.set(corpId,entry);
  return ()=>{if(readers.get(corpId)===entry)readers.delete(corpId);};
}
export async function scopedProviderQuery(service,context,scope,query,read) {
  if(!query||!['chat','interaction'].includes(query.kind)||Object.keys(query).some(k=>!['kind','taskId','offset'].includes(k)))throw Error('invalid_provider_query');
  const grant=()=>service.communicate(context,'join/wecom-assistant/provider-grant',{scope});
  const before=await grant(),parts=JSON.parse(before.source);
  const reader=read??readers.get(parts[1])?.read;if(!reader)throw Error('wecom_provider_read_unavailable');
  const value=await reader({...before,query});
  const after=await grant();if(JSON.stringify(after)!==JSON.stringify(before))throw Error('wecom_scope_retired');
  if(Buffer.byteLength(JSON.stringify(value))>850000)throw Error('wecom_provider_result_too_large');
  return value;
}
export async function resolveProviderRead(service,context,result) {
  return result?.providerQuery?scopedProviderQuery(service,context,result.providerQuery.scope,result.providerQuery.query):result;
}
