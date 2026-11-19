import { humanKey } from './store.mjs';
import { selectionPage, selectionErrorPage } from './selection-page.mjs';
export const SELECTION_PATH = '/wecom/record/';
const json = (res, status, value) => {res.writeHead(status, {'content-type':'application/json; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));};
const fail = (status, message) => Object.assign(Error(message), {status});

/** A signed callback issues the group context; a browser login proves its sender.
 * The native target's one-use link proof is exchanged internally, never typed. */
export function createGroupSelection({store,transport,corpId,authenticate,beginLogin,listServers,enabled=false,track=job=>job}) {
  async function owner(req,ticket) {
    const selection=await store.selection(ticket);
    if(!selection)throw fail(410,'链接已过期，请回到企微群重新 @机器人。');
    const identity=await authenticate(req);
    if(!identity)throw fail(401,'请先登录。');
    const p=identity.principal;
    if(p.provider!=='tencentoa'||p.expiresAt<=Date.now())throw fail(403,'请使用发送本次群聊命令的账号登录。');
    const account=(await transport.resolveSender(selection.source,selection.userId,AbortSignal.timeout(5000))).toLowerCase();
    if(p.attributes?.loginName?.toLowerCase()!==account||!p.aliases?.includes('login:'+account))throw fail(403,'请使用发送本次群聊命令的账号登录。');
    return {...selection,identity};
  }
  async function state(selection) {
    const snapshot=await store.snapshot(selection.source);
    const available=enabled?(await listServers(selection.identity.principal)).servers:[];
    const ready=new Set((await store.recordingServers()).map(s=>s.id));
    const servers=available.filter(s=>ready.has(s.id)).map(({id,name,route})=>({id,name,route}));
    return {enabled,servers,queued:snapshot.count,dropped:snapshot.dropped,
      binding:snapshot.binding?{serverId:snapshot.binding.serverId,route:available.find(s=>s.id===snapshot.binding.serverId)?.route??null,name:available.find(s=>s.id===snapshot.binding.serverId)?.name??'已选择的服务器',channelId:available.some(s=>s.id===snapshot.binding.serverId)?snapshot.channelId:null,delivered:snapshot.lastDeliveredAt>0,receiverOnline:ready.has(snapshot.binding.serverId)}:null};
  }
  async function handle(req,res,ticket) {
    const api=req.url.includes('?status');
    if(req.headers.host!=='join.woa.com')throw fail(403,'入口不可用。');
    let selection;
    try {selection=await owner(req,ticket);}catch(error){
      if(error.status===401&&req.method==='GET'&&!api&&req.headers.accept?.includes('text/html'))return beginLogin(req,res);
      throw error;
    }
    const origin=selection.identity.origin;
    if(req.headers.origin!==undefined&&req.headers.origin!==origin)throw fail(403,'请求来源无效。');
    if(req.method==='GET') {
      const current=await state(selection);
      if(api)return json(res,200,current);
      res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','x-content-type-options':'nosniff',
        'content-security-policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"});
      res.end(selectionPage(current));return;
    }
    if(req.method!=='POST')throw fail(405,'此操作不支持。');
    if(req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'||req.headers['x-wecom-recording']!=='1'||req.headers['content-type']!=='application/json')throw fail(403,'请求来源无效。');
    req.setTimeout(4000,()=>req.destroy());
    let body='';for await(const chunk of req){body+=chunk;if(Buffer.byteLength(body)>1024)throw fail(413,'请求过大。');}
    let input;try{input=JSON.parse(body);}catch{throw fail(400,'请求无效。');}
    if(!input||Object.keys(input).some(k=>!['serverId','code'].includes(k))||typeof input.serverId!=='string'||!/^[A-Za-z0-9._-]{1,128}$/u.test(input.serverId))throw fail(400,'请选择服务器。');
    const current=await state(selection);
    if(!enabled)throw fail(409,'群聊记录服务尚未接通，请稍后重试。');
    if(current.binding){
      if(current.binding.serverId!==input.serverId)throw fail(409,'本群已设置记录位置，暂不支持切换。');
      return json(res,200,current);
    }
    if(!current.servers.some(s=>s.id===input.serverId))throw fail(403,'该服务器当前无法接收本群记录，请刷新后重新选择。');
    const human=humanKey(corpId,selection.userId);
    if(input.code!==undefined){
      if(typeof input.code!=='string'||!await store.attachLink(input.code,selection.source,selection.userId,input.serverId))throw fail(409,'身份确认已失效，请重新确认保存。');
      return json(res,202,{confirming:true});
    }
    if(!(await store.candidates(human)).some(s=>s.id===input.serverId))return json(res,202,{confirming:true});
    try{await store.bind(selection.source,human,input.serverId,'企业微信群');}
    catch(error){if(['already_bound','identity_denied','server_unavailable'].includes(error.message))throw fail(409,'保存位置已变化或服务器暂不可用，请刷新页面重试。');throw error;}
    return json(res,200,await state(selection));
  }
  return {
    async reply(source,job) {
      const ticket=await store.beginSelection(source,job.userId),snapshot=await store.snapshot(source);
      const status=!enabled?'群聊记录接收服务尚未接通，目前无法设置本群记录位置。':snapshot.binding?'本群已选择记录服务器，打开页面查看保存状态。':'为本群选择聊天记录保存的服务器，确认后开始同步到原生群聊。';
      return `### 本群聊天记录\n${status}\n\n[选择或查看本群记录位置](https://join.woa.com${SELECTION_PATH}${ticket})\n\n请使用本次 @机器人的账号打开，链接 15 分钟内有效。`;
    },
    ingress(req,res) {
      if(!req.url?.startsWith(SELECTION_PATH))return false;
      const path=req.url.split('?',1)[0],ticket=path.slice(SELECTION_PATH.length);
      void track(handle(req,res,ticket)).catch(error=>{
        if(res.headersSent){res.destroy();return;}
        const status=error.status??503,message=error.status?error.message:'暂时无法查询，请稍后重试。';
        if(req.method==='GET'&&!req.url.includes('?status')&&req.headers.accept?.includes('text/html')){
          res.writeHead(status,{'content-type':'text/html; charset=utf-8','cache-control':'private, no-store','referrer-policy':'no-referrer','x-frame-options':'DENY','x-content-type-options':'nosniff','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'"});
          res.end(selectionErrorPage(message));
        }else json(res,status,{error:message});
      });return true;
    },
  };
}
