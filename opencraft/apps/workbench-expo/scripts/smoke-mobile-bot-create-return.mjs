import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const {chromium}=await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE || 'playwright');
// The original frontend controller runs unchanged; only transport/Chat APIs are fixtures.
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
let html=await readFile(root+'/opencraft/apps/workbench-expo/assets/mobile-bot-runtime.html','utf8');
const setup=`
window.__LIGHTVELA_EMBEDDED_REGION__='global';
window.__LIGHTVELA_EMBEDDED_API_BASE__='https://api.lightvela.ai';
window.__LIGHTVELA_EMBEDDED_SITE_BASE__='https://lightvela.ai';
window.__LIGHTVELA_EMBEDDED_TOKEN__='fixture-token';
window.__LIGHTVELA_BOT_RUNTIME_ID__='create-return';
localStorage.setItem('lightclaw-auth-token-v1','fixture-token');
window.messages=[];
window.ReactNativeWebView={postMessage(raw){messages.push(JSON.parse(raw).payload)}};
window.__LIGHTVELA_BOT_POST__=payload=>messages.push(payload);
window.send=payload=>window.dispatchEvent(new CustomEvent('opencraft-mobile-bot-command',{detail:JSON.stringify({protocol:1,runtimeId:'create-return',payload})}));
window.chatCreates=0;window.chatDisposals=0;window.chatMounts=0;
class FixtureChat extends HTMLElement {
 configure(){this.selected='fixture-other';this.innerHTML='<input id="chat-draft" aria-label="Fixture draft">';window.chatMounts++}
 prepare(){this.publish();return Promise.resolve()}
 show(){this.style.display='block';return Promise.resolve()}
 hide(){this.style.display='none'}
 dispose(){window.chatDisposals++;return Promise.resolve()}
 publish(){this.dispatchEvent(new CustomEvent('opencraft-sessions',{detail:{sessions:[{chatId:'fixture-chat',title:'Existing conversation'},{chatId:'fixture-other',title:'Other conversation'}],loading:false,selectedChatId:this.selected,error:null}}))}
 createConversation(){window.chatCreates++;this.selected='';this.publish();return Promise.resolve()}
 selectConversation(id){this.selected=id;this.dataset.selected=id}
 renameConversation(){return Promise.resolve()}
 deleteConversation(){return Promise.resolve()}
 setConversationPinned(){return Promise.resolve()}
}
customElements.define('opencraft-embedded-workbench',FixtureChat);
window.fetch=async url=>{const path=new URL(String(url),location.href).pathname;return new Response(JSON.stringify(path==='/v1/passes'?{data:{passes:[{pass_id:'fixture-pass',user_id:'usr_local_preview',bundle_id:'bundle_launch_01',bundle_name:'Launch',created_time:new Date().toISOString(),expired_time:new Date(Date.now()+86400000).toISOString(),agent_quota_total:1,agent_quota_available:0,credit_total:100,credit_available:100}]}}:{}),{status:path==='/v1/passes'?200:503,headers:{'content-type':'application/json'}})};
`;
html=html.replace(/<script type="module" data-opencraft-bundled-chat>[\s\S]*?<\/script>/,`<script>${setup}</script>`).replace("NODE_ENV: 'production',","NODE_ENV: 'production', NEXT_PUBLIC_LOCAL_PREVIEW_AUTH:'1',");
const server=createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(html)});await new Promise(r=>server.listen(0,'127.0.0.1',r));const browser=await chromium.launch({...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE?{executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE}:{}),headless:true,args:['--no-sandbox']});
try {
 for(const width of [390,1024]) {
 const page=await browser.newPage({viewport:{width,height:844}});page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('http://127.0.0.1:'+server.address().port,{waitUntil:'domcontentloaded',timeout:30000});
 await page.waitForFunction(()=>messages.some(m=>m.type==='bot-console-state'&&m.commandsReady));
 await page.locator('#chat-draft').fill('Retain my draft');
 for(const command of [{type:'session',botId:'bot_local_preview',action:'select',chatId:'fixture-chat'},{type:'session',botId:'bot_local_preview',action:'create'},{type:'select',botId:'bot_local_preview',section:'chat'}]){
  await page.evaluate(()=>send({type:'create'}));await page.getByText('Name',{exact:true}).waitFor();
  assert.equal(await page.locator('opencraft-embedded-workbench').count(),1,'Chat controller must stay mounted during creation');
  assert.equal(await page.locator('.lv-agent-settings-grid').isVisible(),false,'Retained controller canvas must be hidden');
  await page.evaluate(()=>send({type:'session',botId:'retired-bot',action:'select',chatId:'fixture-chat'}));
  assert.equal(await page.getByText('Name',{exact:true}).isVisible(),true,'Another Bot must not consume this intent');
  await page.evaluate(command=>send(command),command);
  await page.getByText('Name',{exact:true}).waitFor({state:'hidden'});
  await page.locator('#chat-draft').waitFor({state:'visible'});
  if(command.action==='select') await page.waitForFunction(()=>document.querySelector('opencraft-embedded-workbench')?.dataset.selected==='fixture-chat');
  assert.equal(await page.locator('#chat-draft').inputValue(),'Retain my draft');
  assert.equal(await page.evaluate(()=>chatMounts),1);assert.equal(await page.evaluate(()=>chatDisposals),0);
 }
 assert.equal(await page.evaluate(()=>chatCreates),1);assert.deepEqual(errors,[]);
 console.log(`Create → existing/new session/same Bot at ${width}: PASS; controller/draft retained; stale Bot rejected; zero page exceptions.`);
 await page.close();
 }
} finally{await browser.close();await new Promise(r=>server.close(r))}
