import {createServer} from 'vite';
import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const source=`import{openIndexedDbClientResources}from'/apps/workbench-web/src/runtime/indexeddb-client-resources.ts';
import{createBrowserConversationDraftStorage}from'/apps/workbench-web/src/runtime/browser-conversation-drafts.ts';
import{ClientLocalDocuments}from'@opencraft/document-storage/client-local-documents';
import{conversationDraftStorageKey,serializeConversationDraftDocument}from'@opencraft/workbench-runtime';
const persistence=await openIndexedDbClientResources('startup-draft-probe',indexedDB);let reads=0;const wrapped={...persistence,read:async key=>{reads++;return persistence.read(key)}};
const docs=new ClientLocalDocuments(Promise.resolve(wrapped),'fixture','conversation-draft');
const adapter=createBrowserConversationDraftStorage('fixture',docs);
const wanted={type:'new-thread',draftId:'wanted',execution:{hostId:'host',workspace:{cwd:'/project',runtimeWorkspaceRoots:['/project']}}};
const document={version:1,blocks:[{type:'paragraph',children:[{type:'text',text:'unfinished input '.repeat(4000)}]}]};
const saved=serializeConversationDraftDocument(document,wanted);const wantedKey=conversationDraftStorageKey('fixture','original-view',wanted);
await docs.read(wantedKey);await docs.write(wantedKey,saved);
for(let i=0;i<80;i++){const target=i%2?{type:'new-thread',draftId:'other'+i,execution:wanted.execution}:{type:'existing-thread',key:{hostId:'host',threadId:'thread'+i}};const key=conversationDraftStorageKey('fixture','view'+i,target);await docs.read(key);await docs.write(key,serializeConversationDraftDocument(document,target));}
window.run=async()=>{reads=0;const start=performance.now();const target=await adapter.loadNewTarget('wanted');return{ms:performance.now()-start,reads,target};};
window.cases=async()=>{const raw=await docs.read(wantedKey);await adapter.storage.remove(wantedKey);const tombstone=await adapter.loadNewTarget('wanted');
 await adapter.storage.save(wantedKey,raw);const restored=await adapter.loadNewTarget('wanted');
 const malformedKey='opencraft.draft.v1.fixture.legacy';await docs.read(malformedKey);const legacy={...wanted,draftId:'legacy'};await docs.write(malformedKey,serializeConversationDraftDocument(document,legacy));const recovered=await adapter.loadNewTarget('legacy');
 const absent=await adapter.loadNewTarget('absent');
 const oldTarget={...wanted,draftId:'local-only'};const oldKey=conversationDraftStorageKey('fixture','old-view',oldTarget);window.localStorage.setItem(oldKey,serializeConversationDraftDocument(document,oldTarget));const localOnly=await adapter.loadNewTarget('local-only');
 const tombTarget={...wanted,draftId:'deleted-legacy'};const tombKey=conversationDraftStorageKey('fixture','deleted-view',tombTarget);await docs.read(tombKey);await docs.write(tombKey,null);window.localStorage.setItem(tombKey,serializeConversationDraftDocument(document,tombTarget));const deletedLegacy=await adapter.loadNewTarget('deleted-legacy');
 let finish;const gate=new Promise(resolve=>{finish=resolve});const pending=createBrowserConversationDraftStorage('fixture',{keys:async()=>[wantedKey],read:async()=>{await gate;return raw},revokeAndClear:async()=>{}});const delayed=pending.loadNewTarget('wanted');await Promise.resolve();pending.revokeAndClear();finish();const revokedDuringRead=await delayed;
const text=await docs.read(wantedKey);adapter.revokeAndClear();const revoked=await adapter.loadNewTarget('wanted');return{tombstone,restored,recovered,absent,localOnly,deletedLegacy,revokedDuringRead,revoked,originalPreserved:text===raw};};window.ready=true;`;
const vite=await createServer({configFile:false,root,logLevel:'error',resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0,hmr:false},plugins:[{name:'draft-recovery-fixture',resolveId:id=>id==='/fixture.ts'?id:null,load:id=>id==='/fixture.ts'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url!=='/')return next();res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><script type="module" src="/fixture.ts"></script>')})}}]});
let browser;
try {
 await vite.listen();browser=await chromium.launch({headless:true});
 for(const touch of [false,true]) {
  const page=await browser.newPage({viewport:{width:touch?390:1280,height:720},hasTouch:touch,isMobile:touch});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto('http://127.0.0.1:'+vite.httpServer.address().port);await page.waitForFunction(()=>window.ready,undefined,{timeout:60000});
  const sample=await page.evaluate(()=>window.run());assert.equal(sample.reads,1,'unrelated canonical drafts must not deserialize their bodies');assert.equal(sample.target.execution.hostId,'host');
  const cases=await page.evaluate(()=>window.cases());assert.equal(cases.tombstone,null);assert.equal(cases.restored.draftId,'wanted');assert.equal(cases.recovered.draftId,'legacy');assert.equal(cases.localOnly.draftId,'local-only');assert.equal(cases.deletedLegacy,null);assert.equal(cases.revokedDuringRead,null);assert.equal(cases.absent,null);assert.equal(cases.revoked,null);assert.equal(cases.originalPreserved,true);assert.deepEqual(errors,[]);
  console.log(JSON.stringify({touch,reads:sample.reads,ms:sample.ms,cases}));await page.close();
 }
}finally{await browser?.close();await vite.close();}
