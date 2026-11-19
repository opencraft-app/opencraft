/** Bounded allowlisted diagnostics. Never serialize provider objects or exception stacks. */
export function cleanProviderMessage(value, secrets=[]) {
 if(typeof value!=='string')return undefined;
 let text=value.slice(0,8192);
 for(const secret of secrets)if(typeof secret==='string'&&secret)text=text.split(secret).join('[redacted]');
 return text.replace(/https?:\/\/[^\s<>"']+/giu,'[url]')
  .replace(/(?:access[_-]?token|corpsecret|secret|authorization|password|token)\s*["']?\s*[:=]\s*["']?\s*(?:Bearer\s+)?[^\s,;"']+/giu,'[credential redacted]')
  .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,' ').slice(0,300);
}
export function errorCategory(error) {
 if(error?.name==='TypeError')return 'type_or_network';
 if(error?.name==='SyntaxError')return 'invalid_response';
 if(error?.name==='TimeoutError'||error?.code==='ETIMEDOUT')return 'timeout';
 if(error?.name==='AbortError')return 'aborted';
 if(error?.code==='WE_COM_HTTP')return 'http';
 if(error?.code==='WE_COM_RESPONSE')return 'invalid_response';
 return 'network_or_unavailable';
}
/** Provider write evidence, not a permanent permission or the native owner's role. */
export const ownerPrivilegeRequired = diagnostics => diagnostics?.write?.errcode === 86101;
export function safeDiagnostics(input) {
 if(!input||typeof input!=='object')return undefined;
 const out={};
 for(const key of ['operationId','correlationId'])if(typeof input[key]==='string'&&/^[a-f0-9-]{16,64}$/u.test(input[key]))out[key]=input[key];
 for(const key of ['stage','action','category','state','confirmation'])if(typeof input[key]==='string'&&/^[a-z_]{1,40}$/u.test(input[key]))out[key]=input[key];
 if(['/cgi-bin/tencent/chat/update','/cgi-bin/tencent/chat/get'].includes(input.apiPath))out.apiPath=input.apiPath;
 if(Number.isSafeInteger(input.errcode))out.errcode=input.errcode;
 if(typeof input.errmsg==='string')out.errmsg=cleanProviderMessage(input.errmsg);
 if(Number.isFinite(input.elapsedMs))out.elapsedMs=Math.max(0,Math.min(86400000,Math.round(input.elapsedMs)));
 for(const key of ['write','readback'])if(input[key]&&typeof input[key]==='object') {
  const {write,readback,...leaf}=input[key];out[key]=safeDiagnostics(leaf);
 }
 return out;
}
export function logOperation(input) {
 try{console.warn(JSON.stringify({event:'wecom_operation',...safeDiagnostics(input)}));}catch{/* diagnostics cannot change delivery */}
}
