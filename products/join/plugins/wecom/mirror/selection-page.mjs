const encode = value => JSON.stringify(value).replace(/</g, '\\u003c');
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
const icon = (name, size = 24) => {
  const paths = {
    chat: '<path d="M21 11.5a8.5 8.5 0 0 1-8.5 8.5H4l-3 3V11.5A8.5 8.5 0 0 1 9.5 3h3a8.5 8.5 0 0 1 8.5 8.5Z"/><path d="M7 10h8M7 14h5"/>',
    server: '<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01M12 6.5h4M12 17.5h4"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  };
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name]}</svg>`;
};
const styles = `
:root{color-scheme:light;--bg:#f5f7fa;--surface:#fff;--text:#17243b;--muted:#627086;--line:#e4e9f0;--brand:#275ed7;--tint:#eef4ff;--green:#137b62;--green-bg:#edf8f3;--amber:#936219;--amber-bg:#fff7e8;--danger:#ae3b34;font:15px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--text);background:var(--bg)}
*{box-sizing:border-box}body{margin:0}button,input,a{-webkit-tap-highlight-color:transparent}button,a,input{touch-action:manipulation}button,input{font:inherit}button,a{transition:background .15s,border-color .15s}button{cursor:pointer}button:disabled{cursor:default}svg{flex:none}a{color:var(--brand);text-underline-offset:4px}h1,h2,p{margin:0}[hidden]{display:none!important}:focus-visible{outline:3px solid var(--brand);outline-offset:4px}
.shell{max-width:620px;margin:0 auto;padding:28px 24px max(28px,env(safe-area-inset-bottom))}.brand{display:flex;align-items:center;gap:9px;font-size:21px;font-weight:750;letter-spacing:-.6px}.brand-mark{width:30px;height:30px;display:grid;place-items:center;background:var(--brand);border-radius:9px;color:#fff;font-size:20px;letter-spacing:0}.brand small{margin-left:auto;letter-spacing:.3px;font-size:12px;font-weight:500;color:var(--muted)}.intro{padding:36px 0 24px}.eyebrow{display:inline-flex;align-items:center;gap:6px;color:var(--green);font-size:12px;font-weight:600;margin-bottom:12px}.eyebrow:before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}h1{font-size:30px;line-height:1.35;letter-spacing:-.8px;font-weight:700}.intro p{color:var(--muted);margin-top:12px;max-width:480px;line-height:1.8}
.steps{display:flex;list-style:none;padding:0;margin:0 0 24px;font-size:12px;color:var(--muted);gap:8px}.steps li{display:flex;align-items:center;gap:7px;flex:1;white-space:nowrap}.steps li:not(:last-child):after{content:"";height:1px;background:var(--line);flex:1;margin-left:1px}.steps b{width:21px;height:21px;border:1px solid var(--line);border-radius:50%;display:grid;place-items:center;font-size:11px;font-weight:600}.steps .active{color:var(--brand);font-weight:600}.steps .active b{background:var(--brand);border-color:var(--brand);color:#fff}.steps .done b{background:var(--green-bg);border-color:var(--green-bg);color:var(--green)}
.panel{background:var(--surface);border:1px solid var(--line);border-radius:20px;padding:26px;box-shadow:0 6px 24px #16253e04}fieldset{padding:0;margin:0;border:0;min-width:0}legend{padding:0;font-size:17px;font-weight:650}.hint{font-size:13px;color:var(--muted);margin-top:5px}.servers{display:grid;gap:10px;margin-top:20px}.server{display:flex;align-items:center;gap:12px;position:relative;padding:16px;border:1px solid var(--line);border-radius:12px;cursor:pointer;min-height:80px}.server:hover{border-color:var(--brand)}.server[data-selected="true"]{border-color:var(--brand);background:var(--tint);box-shadow:0 0 0 1px var(--brand)}.server input{margin:0;width:19px;height:19px;accent-color:var(--brand);flex:none;order:3}.server-icon{width:40px;height:40px;display:grid;place-items:center;background:var(--bg);color:var(--muted);border-radius:10px;flex:none}.server[data-selected="true"] .server-icon{background:var(--surface);color:var(--brand)}.server-copy{flex:1;min-width:0}.server-name{display:block;font-weight:650;font-size:16px;overflow-wrap:anywhere}.server-meta{display:flex;align-items:center;gap:5px;font-size:12px;color:var(--muted);margin-top:3px}.server-meta:before{content:"";width:5px;height:5px;border-radius:50%;background:var(--green)}
.queue{display:flex;gap:10px;align-items:flex-start;padding:15px 0;margin-top:6px;color:var(--muted);font-size:12px}.queue svg{margin-top:3px}.queue strong{display:block;font-size:13px;color:var(--text);font-weight:550}.primary{display:flex;align-items:center;justify-content:center;gap:10px;background:var(--brand);border:1px solid var(--brand);border-radius:11px;color:#fff;width:100%;min-height:48px;padding:12px 16px;font-weight:600;text-decoration:none}.primary:hover{filter:brightness(.96)}.primary:disabled{background:var(--line);border-color:var(--line);color:var(--muted);filter:none}.confirmation{font-size:12px;color:var(--muted);text-align:center;margin-top:12px}.text-button{border:0;background:transparent;color:var(--brand);padding:10px 12px;min-height:44px;border-radius:8px}.text-button:hover{background:var(--tint)}
.empty{text-align:center;padding:28px 8px 12px}.empty .server-icon{margin:0 auto 14px;width:52px;height:52px;border-radius:15px}.empty h2{font-size:16px}.empty p{color:var(--muted);font-size:13px;margin:8px auto 6px;max-width:330px}.status-head{display:flex;gap:12px;align-items:center;margin-bottom:20px}.status-icon{width:44px;height:44px;border-radius:14px;background:var(--tint);color:var(--brand);display:grid;place-items:center;flex:none}.status-head h2{font-size:19px;line-height:1.5}.status-head p{font-size:12px;color:var(--muted)}.status-head[data-tone="success"] .status-icon{background:var(--green-bg);color:var(--green)}.status-head[data-tone="waiting"] .status-icon{background:var(--amber-bg);color:var(--amber)}.destination{display:flex;gap:12px;align-items:center;padding:16px;background:var(--bg);border-radius:12px}.destination small{display:block;color:var(--muted);font-size:12px}.destination strong{display:block;overflow-wrap:anywhere;font-size:16px}.destination div{min-width:0}.status-copy{margin:16px 0;color:var(--muted);font-size:14px}.dropped{color:var(--amber);background:var(--amber-bg);border-radius:10px;padding:12px 14px;margin-top:16px;font-size:13px}.notice{color:var(--danger);background:var(--surface);border:1px solid var(--line);border-radius:12px;margin-top:16px;padding:14px 16px;font-size:13px}.notice p{overflow-wrap:anywhere}.notice .text-button{padding-left:0}.help{margin-top:22px;padding:0 2px;color:var(--muted);font-size:12px;line-height:1.8}.help summary{cursor:pointer;min-height:40px;display:list-item;align-content:center;font-size:13px;color:var(--text)}.help p{margin:5px 0 10px}.footer{text-align:center;color:var(--muted);font-size:11px;margin-top:32px;letter-spacing:.4px}.error-panel h1{font-size:23px}.error-panel p{margin-top:14px;color:var(--muted)}.error-panel .status-icon{margin-bottom:20px}
@media(max-width:440px){.shell{padding:20px 18px max(24px,env(safe-area-inset-bottom))}.intro{padding:28px 0 22px}h1{font-size:27px}.panel{padding:20px;border-radius:16px}.steps{gap:6px;font-size:11px}.steps li{gap:5px}.server{padding:14px;gap:10px}.brand small{font-size:11px}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#121923;--surface:#1a2433;--text:#e7edf6;--muted:#a2b0c5;--line:#344156;--brand:#8db2ff;--tint:#233451;--green:#7ed8b4;--green-bg:#203d36;--amber:#edc57d;--amber-bg:#3a3022;--danger:#ffaaa2}.primary,.brand-mark{color:#12223c}.steps .active b{color:#12223c}.panel{box-shadow:none}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}@media(forced-colors:active){.server[data-selected="true"]{outline:2px solid Highlight}.primary{border:1px solid ButtonText}}
`;
const brand = '<header class="brand"><span class="brand-mark" aria-hidden="true">J</span>Join<small>企业微信群聊</small></header>';
const head = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>本群聊天记录 · Join</title><style>${styles}</style></head>`;
export function selectionErrorPage(message) {
  return `${head}<body><div class="shell">${brand}<main class="panel error-panel" style="margin-top:36px"><div class="status-icon">${icon('clock')}</div><h1>暂时无法打开群聊记录</h1><p>${escapeHtml(message)}</p><p>回到原企微群重新 <strong>@机器人</strong>，再打开新回复中的链接。</p><p class="hint">请使用发送本次群聊命令的账号打开。</p></main><footer class="footer">Join · 让讨论留在一起</footer></div></body></html>`;
}
/** Relay's standalone chooser: no navigation to a server until saving is confirmed. */
export function selectionPage(initial) {
  return `${head}<body><div class="shell">${brand}<main>
<section class="intro"><span class="eyebrow">来自你刚才 @机器人的群</span><h1>本群聊天记录</h1><p>为这个群选择一个保存位置。确认后，群消息会自动同步到所选服务器的群聊中。</p></section>
<ol class="steps" aria-label="设置进度"><li data-step="0"><b>1</b>选择服务器</li><li data-step="1"><b>2</b>确认保存</li><li data-step="2"><b>3</b>开始同步</li></ol>
<div class="panel"><form><fieldset><legend>保存到哪台服务器</legend><p class="hint" id="server-hint">仅显示你有权限且可接收群聊记录的服务器</p><div id="servers" class="servers" aria-describedby="server-hint"></div></fieldset>
<div id="empty" class="empty" hidden><div class="server-icon">${icon('server')}</div><h2 id="empty-title"></h2><p id="empty-copy"></p><button class="text-button" type="button" id="reload">刷新服务器列表</button></div>
<div class="queue" id="queue">${icon('clock',18)}<div><strong id="queue-title"></strong><span>设置前最多暂存 200 条消息，确认后开始同步。</span></div></div>
<button id="confirm" class="primary" type="submit" disabled><span id="confirm-label">确认保存到所选服务器</span>${icon('arrow',18)}</button><p class="confirmation" id="confirmation">确认后，将为本群持续保存聊天记录</p></form>
<section id="saved" hidden aria-label="群聊记录保存状态"><div class="status-head" id="status-head"><div class="status-icon" id="status-icon">${icon('clock')}</div><div><h2 id="status-title"></h2><p id="status-caption"></p></div></div><div class="destination">${icon('server')}<div><small>本群记录位置</small><strong id="destination"></strong></div></div><p id="status-copy" class="status-copy" role="status" aria-live="polite"></p><a id="enter" class="primary" hidden>打开本群聊天记录 ${icon('arrow',18)}</a></section>
<p id="dropped" class="dropped" hidden></p></div>
<div id="notice" class="notice" hidden><p id="error" role="alert"></p><button id="retry" type="button" class="text-button">刷新状态</button></div>
<details class="help"><summary>这些设置会影响什么？</summary><p>只设置发起本次命令的企微群。确认后，暂存消息和后续群消息会同步到所选服务器的原生群聊。</p><p>保存位置设置后暂不支持在此切换。请使用本次 @机器人的账号打开链接；链接过期后，在群里重新 @机器人即可。</p></details>
<noscript><p class="notice">请启用浏览器 JavaScript 后重新打开，以选择服务器并确认保存。</p></noscript></main><footer class="footer">Join · 让讨论留在一起</footer></div>
<script>
const initial=${encode(initial)};
const $=id=>document.getElementById(id),form=document.querySelector('form'),list=$('servers'),button=$('confirm'),fieldset=form.querySelector('fieldset');
const serverIcon=${encode(icon('server',21))},clockIcon=${encode(icon('clock'))},checkIcon=${encode(icon('check'))};
let current=initial,busy=false,stopped=false,selected='';
function serverBase(route){if(typeof route!=='string'||!/^[A-Za-z0-9._-]{1,128}$/.test(route))throw Error('服务器入口已变化，请刷新后重试。');return '/servers/'+encodeURIComponent(route);}
function progress(step){document.querySelectorAll('[data-step]').forEach((item,index)=>{item.className=index===step?'active':index<step?'done':'';if(index===step)item.setAttribute('aria-current','step');else item.removeAttribute('aria-current');});}
function controls(){fieldset.disabled=busy||stopped;button.disabled=busy||stopped||!current.enabled||!selected;form.setAttribute('aria-busy',String(busy));$('confirm-label').textContent=busy?'正在确认保存…':'确认保存到所选服务器';for(const label of list.children)label.dataset.selected=String(label.querySelector('input').checked);}
function error(message){$('notice').hidden=false;$('error').textContent=message;$('retry').hidden=stopped;controls();}
function show(value){current=value;$('notice').hidden=true;const bound=!!value.binding;form.hidden=bound;$('saved').hidden=!bound;progress(bound?2:busy?1:0);
 if(!bound){
  if(!value.servers.some(s=>s.id===selected))selected=value.servers.length===1?value.servers[0].id:'';
  list.replaceChildren();
  for(const s of value.servers){const label=document.createElement('label'),input=document.createElement('input'),badge=document.createElement('span'),copy=document.createElement('span'),name=document.createElement('span'),meta=document.createElement('span');label.className='server';input.type='radio';input.name='server';input.value=s.id;input.required=true;input.checked=selected===s.id;badge.className='server-icon';badge.innerHTML=serverIcon;copy.className='server-copy';name.className='server-name';name.textContent=s.name;meta.className='server-meta';meta.textContent='可接收群聊记录';copy.append(name,meta);label.append(input,badge,copy);list.append(label);}
  const empty=!value.enabled||!value.servers.length;$('empty').hidden=!empty;list.hidden=empty;button.hidden=empty;$('confirmation').hidden=empty;
  $('empty-title').textContent=value.enabled?'暂无可用的记录服务器':'群聊记录暂未开放';$('empty-copy').textContent=value.enabled?'你有权限的服务器中，暂时没有可接收群聊记录的服务器。接收端就绪后可刷新重试。':'接收服务尚未接通，请联系管理员后重试。';
  $('queue-title').textContent=value.queued?'已为本群暂存 '+value.queued+' 条消息':'选择后，从这里开始保存';
 }else{
  const b=value.binding,offline=!value.enabled||!b.receiverOnline,delivered=b.delivered&&!offline;
  $('destination').textContent=b.name;$('status-head').dataset.tone=offline?'waiting':delivered?'success':'pending';$('status-icon').innerHTML=delivered?checkIcon:clockIcon;
  $('status-title').textContent=offline?'等待接收服务器恢复':delivered?'已收到保存回执':'已设置记录位置';
  $('status-caption').textContent=offline?'保存位置已保留':delivered?'群消息已成功送达服务器':'接下来会自动同步群消息';
  $('status-copy').textContent=offline?'接收服务器暂不可用，待保存消息会保留并等待重试。':delivered?(value.queued?'还有 '+value.queued+' 条消息等待保存，正在继续同步。':'当前待保存队列已处理完毕，后续群消息将继续自动同步。'):(value.queued?'正在同步 '+value.queued+' 条暂存消息，等待服务器确认保存。':'下一条群消息送达后，这里会显示保存回执。');
  const located=typeof b.route==='string'&&/^[A-Za-z0-9._-]{1,128}$/.test(b.route)&&typeof b.channelId==='string'&&/^group:[a-f0-9-]{36}$/.test(b.channelId);
  $('enter').hidden=!b.delivered||!located;
  if(located)$('enter').href=serverBase(b.route)+'/views/opencraft.im.channel-chat?resource='+encodeURIComponent('opencraft-channel:'+b.channelId);else $('enter').removeAttribute('href');
  if(b.delivered&&!located&&!offline)$('status-copy').textContent+=' 正在获取本群入口，请稍候。';
 }
 $('dropped').hidden=!value.dropped;$('dropped').textContent='超出暂存上限的 '+value.dropped+' 条消息未保存。';controls();
}
async function request(url,body){const response=await fetch(url,{method:body?'POST':'GET',credentials:'same-origin',redirect:'error',headers:body?{'content-type':'application/json','x-wecom-recording':'1'}:{accept:'application/json'},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(10000)});const value=await response.json();if(!response.ok){if(url.startsWith(location.pathname)&&[401,403,410].includes(response.status))stopped=true;throw Error(typeof value.error==='string'?value.error:'操作暂时未完成，请稍后重试。');}return value;}
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
form.addEventListener('change',()=>{selected=new FormData(form).get('server')||'';controls();});
form.addEventListener('submit',async event=>{event.preventDefault();if(busy||stopped||!selected)return;const serverId=selected;busy=true;$('notice').hidden=true;progress(1);controls();try{
 const route=current.servers.find(s=>s.id===serverId)?.route;
 const proof=await request(serverBase(route)+'/__opencraft_im',{action:'wecom.link'});
 if(typeof proof.code!=='string')throw Error('该服务器尚未接入群聊记录，请联系部署管理员。');
 await request(location.pathname,{serverId,code:proof.code});let result;
 for(let i=0;i<20;i++){await pause(500);result=await request(location.pathname,{serverId});if(result.binding)break;}
 if(!result?.binding)throw Error('服务器尚未确认，请稍后再次点击保存。');show(result);
 }catch(cause){error(cause.message);}finally{busy=false;progress(current.binding?2:0);controls();}});
async function reload(){if(busy||stopped)return;busy=true;controls();$('reload').disabled=true;$('retry').disabled=true;try{show(await request(location.pathname+'?status'));}catch(cause){error(cause.message);}finally{busy=false;progress(current.binding?2:0);$('reload').disabled=stopped;$('retry').disabled=stopped;controls();}}
$('reload').addEventListener('click',reload);$('retry').addEventListener('click',reload);
addEventListener('pagehide',()=>{stopped=true;});
async function refresh(){if(stopped)return;if(current.binding&&!busy){try{show(await request(location.pathname+'?status'));}catch(cause){error(stopped?cause.message:'暂时无法查询最新保存状态，请刷新重试。');}}if(!stopped)setTimeout(refresh,3000);}
show(initial);setTimeout(refresh,3000);
</script></body></html>`;
}
