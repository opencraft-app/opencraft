/** Server-owned presentation, separate from optional product accounts in Workbench. */
export function humanLoginPage(nonce: string): string {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>登录 · OpenCraft</title><style>
:root{color-scheme:light dark;font:16px system-ui;background:Canvas;color:CanvasText}*{box-sizing:border-box}
body{margin:0;padding:32px 20px}main{max-width:420px;margin:8vh auto}h1{font-size:26px;margin:0 0 12px}h2{font-size:18px;margin:28px 0 12px}
p{line-height:1.6;color:GrayText}label{display:block;margin:16px 0 6px}input,select,button{font:inherit;min-height:44px;border:1px solid GrayText;border-radius:8px;background:Canvas;color:CanvasText;padding:10px 12px}
input,select{width:100%}button{cursor:pointer}button:disabled{opacity:.5;cursor:default}form>button{width:100%;margin-top:20px}
.actions{display:flex;gap:10px;flex-wrap:wrap;margin:20px 0}.providers{display:grid;gap:10px;margin:16px 0}ul{padding:0;list-style:none}li{display:flex;justify-content:space-between;align-items:center;gap:12px;margin:12px 0}
a{color:inherit;text-underline-offset:4px}:focus-visible{outline:2px solid currentColor;outline-offset:3px}
#notice{position:fixed;top:20px;right:20px;max-width:min(380px,calc(100vw - 40px));padding:16px;border:1px solid GrayText;border-radius:10px;background:Canvas;box-shadow:0 4px 20px #0002;z-index:2}
[hidden]{display:none!important}@media(max-width:480px){main{margin:4vh auto}}
</style><main><h1 id="heading">登录 OpenCraft</h1><p id="description">使用此服务器的账号继续。</p>
<div id="notice" role="alert" hidden></div><div id="account" hidden><h2>已绑定的登录方式</h2><ul id="bindings"></ul>
<div class="actions"><a href="/">返回工作台</a><button id="logout" type="button">退出登录</button></div><p id="freshness" hidden>请重新登录后再管理登录方式。</p></div>
<form id="local" hidden><h2 id="local-title">本地账号</h2><label id="operation-label" for="operation" hidden>操作</label><select id="operation" name="operation" hidden>
<option value="link">绑定已有本地账号</option><option value="create">设置新的本地账号</option><option value="login">登录另一个账号</option></select>
<label for="username">用户名</label><input id="username" name="username" autocomplete="username" required minlength="3" maxlength="64" pattern="[a-zA-Z0-9][a-zA-Z0-9._-]{2,63}" autocapitalize="none" spellcheck="false">
<label for="password">密码</label><input id="password" name="password" type="password" autocomplete="current-password" required maxlength="1024"><button id="submit" type="submit">登录</button></form>
<div id="providers" class="providers"></div><button id="cancel" type="button" hidden>取消登录</button><p id="setup" hidden>本地账号由服务器管理员创建。</p></main>
<script nonce="${nonce}">
const base='/__opencraft_auth', $=id=>document.getElementById(id);let state=null,busy=false,noticeTimer;
const messages={invalid_credentials:'用户名或密码不正确。',recent_login_required:'请重新登录后再操作。',try_later:'尝试次数较多，请稍后再试。',login_failed:'未能完成操作，请重试。身份已绑定或用户名已使用时，请联系管理员。'};
function notice(message){$('notice').textContent=message;$('notice').hidden=false;clearTimeout(noticeTimer);noticeTimer=setTimeout(()=>$('notice').hidden=true,10000)}
async function api(path,body){const response=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'same-origin'});const value=await response.json();if(!response.ok)throw new Error(messages[value.error]||'暂时无法完成操作，请稍后重试。');return value}
function controls(){for(const el of document.querySelectorAll('button,input,select'))el.disabled=busy;for(const button of document.querySelectorAll('[data-unbind]'))button.disabled=busy||!state?.recent||state.bindings.length<=1}
function operation(){const mode=state?.actor?$('operation').value:'login';$('submit').textContent=mode==='create'?'设置本地账号':mode==='link'?'绑定本地账号':'登录';$('password').autocomplete=mode==='create'?'new-password':'current-password';$('password').minLength=mode==='create'?12:0}
async function refresh(){state=await api('/session');const active=!!state.actor;$('heading').textContent=active?'登录与账号':'登录 OpenCraft';$('description').textContent=active?'当前账号：'+state.actor.displayName:'使用此服务器的账号继续。';$('account').hidden=!active;$('local').hidden=!state.local;$('setup').hidden=active||!state.local;$('operation').hidden=!active;$('operation-label').hidden=!active;$('freshness').hidden=!active||state.recent;
$('bindings').replaceChildren();for(const binding of state.bindings){const li=document.createElement('li'),label=document.createElement('span'),button=document.createElement('button');label.textContent=binding.label;button.type='button';button.textContent='解绑';button.dataset.unbind='true';button.addEventListener('click',()=>run(async()=>{await api('/unbind',{provider:binding.provider,subject:binding.subject});notice('已解绑，请使用保留的登录方式重新登录。');await refresh()}));li.append(label,button);$('bindings').append(li)}
$('providers').replaceChildren();for(const provider of state.providers){const button=document.createElement('button');button.type='button';button.textContent=(active?'绑定 ':'使用 ')+provider.label+(active?'':' 登录');button.addEventListener('click',()=>run(async()=>{const result=await api('/oidc/start',{provider:provider.id,mode:active?'link':'login'});$('cancel').hidden=false;window.location.assign(result.redirectTo)}));$('providers').append(button)}operation();controls()}
async function run(task){if(busy)return;busy=true;controls();try{await task()}catch(error){notice(error.message)}finally{busy=false;controls()}}
$('operation').addEventListener('change',operation);$('local').addEventListener('submit',event=>{event.preventDefault();run(async()=>{const mode=state.actor?$('operation').value:'login',password=$('password').value;$('password').value='';await api(mode==='create'?'/local/create':'/local',{mode:mode==='login'?'login':'link',username:$('username').value,password});if(mode==='login')window.location.assign('/');else{await refresh();notice('登录方式已绑定。')}})});
$('logout').addEventListener('click',()=>run(async()=>{await api('/logout',{});await refresh()}));$('cancel').addEventListener('click',()=>run(async()=>{await api('/cancel',{});$('cancel').hidden=true}));
if(new URLSearchParams(location.search).has('error'))notice('未能完成登录或绑定，请重试。');refresh().catch(()=>notice('暂时无法读取登录信息，请刷新重试。'));
</script></html>`;
}
