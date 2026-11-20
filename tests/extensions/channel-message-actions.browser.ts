import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { navigationLifecycleFixture } from '../fixtures/navigation-lifecycle';

const root=process.cwd(),output=resolve(process.env.OPENCRAFT_ACTIONS_OUTPUT??'.local/channel-message-actions');
const setup=`
window.forwardUploads=[];window.forwardTexts=[];window.fileReads=[];window.rejectForward=false;
const pdf=btoa('%PDF-1.7 original-file-bytes');
const png=(()=>{const c=document.createElement('canvas');c.width=2;c.height=2;c.getContext('2d').fillRect(0,0,2,2);return c.toDataURL('image/png').split(',')[1]})();
const fixtureMessages=[{sequence:1,messageId:'text',author:'Other',text:'Message to forward',at:1000,status:'received'},{sequence:2,messageId:'file',author:'Other',text:'[Attachment: report.pdf]',at:2000,status:'received',attachment:{name:'report.pdf',type:'application/pdf',size:atob(pdf).length}},{sequence:3,messageId:'image',author:'Other',text:'',at:3000,status:'received',image:{state:'ready'}}];
`;
let source=setup+navigationLifecycleFixture;
source=source.replace("const rpc={draftScope:","const rpc={supportsAttachments:true,supportsAttachmentChunks:true,draftScope:");
source=source.replace("request:async(method,p)=>{",`request:async(method,p)=>{
if(method==='opencraft/channels/attachments/read'){window.fileReads.push([p.channelId,p.sequence,p.offset]);const bytes=p.sequence===3?png:pdf;return{name:p.sequence===3?'image.png':'report.pdf',type:p.sequence===3?'image/png':'application/pdf',size:atob(bytes).length,base64:bytes,nextOffset:atob(bytes).length};}
if(method==='opencraft/channels/attachments/upload'){window.forwardUploads.push({...p});if(window.rejectForward)throw Error('channel_denied');return{nextOffset:p.total,receipt:{sequence:30,messageId:'forward-'+p.clientMessageId,author:'Me',text:'[Attachment: report.pdf]',at:Date.now(),status:'sending'}};}
if(method==='opencraft/channels/messages/send'){window.forwardTexts.push({...p});return{receipt:{sequence:31,messageId:'sent',author:'Me',text:p.parts[0].text,at:Date.now(),status:'sending'}};}
if(method==='opencraft/channels/delivery/get')return{receipt:null};
`);
source=source.replace("messages:[],cursor:'one'","messages:fixtureMessages,cursor:'one'");
const server=await createServer({
  root,configFile:false,publicDir:root+'/apps/workbench-web/public',logLevel:'error',cacheDir:output+'/vite-cache',
  resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},
  optimizeDeps:{include:['react','react-dom','react-dom/client','react/jsx-runtime','react-intl','motion/react','@tanstack/react-query','prosemirror-state','prosemirror-view','prosemirror-model','prosemirror-transform','prosemirror-commands','prosemirror-history','prosemirror-keymap','prosemirror-schema-list','prosemirror-inputrules','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','@radix-ui/react-alert-dialog','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','tslib']},
  plugins:[{name:'channel-actions-fixture',resolveId:id=>id==='/actions-fixture.tsx'?id:null,load:id=>id==='/actions-fixture.tsx'?source:null,
    configureServer(vite){vite.middlewares.use((req,res,next)=>{
      if(req.url?.startsWith('/identity-photo/')){
        if(req.url.includes('missing-photo')){res.writeHead(404).end();return;}
        const color=req.url.includes('owner')?'#a6bdc9':req.url.includes('member')?'#bab0c5':'#a8bda9';
        res.setHeader('content-type','image/svg+xml');res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/><circle cx="32" cy="23" r="12" fill="#eef1f3"/><ellipse cx="32" cy="61" rx="22" ry="22" fill="#eef1f3"/></svg>`);return;
      }
      if(!req.headers.accept?.includes('text/html'))return next();
      res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/actions-fixture.tsx"></script>');
    });},
  }],
});
let browser:Awaited<ReturnType<typeof chromium.launch>>|undefined;
const results:unknown[]=[];
try{
 await mkdir(output,{recursive:true});await server.listen();browser=await chromium.launch({headless:true});
 for(const touch of [false,true])for(const theme of ['light','dark']){
  console.log(JSON.stringify({touch,theme,stage:'start'}));
  const context=await browser.newContext({viewport:{width:touch?390:1280,height:900},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(()=>{(window as any).__name=(x:unknown)=>x;Object.defineProperty(AbortSignal,'any',{configurable:true,value:undefined});});
  await context.grantPermissions(['clipboard-read','clipboard-write']);await page.goto(server.resolvedUrls!.local[0]!+'?theme='+theme);
  await page.getByRole('button',{name:'Open Inbox',exact:true}).click();await page.getByRole('button',{name:/Navigation group 0\b/}).first().click();
  const live=page.locator('.page-stack > .page-stack__live'),editor=live.locator('[contenteditable=true]').first();await editor.waitFor();
  const fileRow=live.locator('[role=listitem]').filter({hasText:'[Attachment: report.pdf]'}).first();
  const textRow=live.locator('[role=listitem]').filter({hasText:'Message to forward'}).first();
  await editor.click();await editor.pressSequentially('Unsent draft remains');assert.equal(await editor.innerText(),'Unsent draft remains');
  async function menu(row:ReturnType<typeof page.locator>){await row.scrollIntoViewIfNeeded();if(touch){const box=await row.boundingBox();assert.ok(box);const cdp=await context.newCDPSession(page);const p={x:box.x+box.width/2,y:box.y+box.height/2};await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});await page.waitForTimeout(850);await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await cdp.detach();}else await row.click({button:'right'});await page.getByRole('menuitem',{name:'Forward',exact:true}).waitFor();}
  await menu(fileRow);assert.equal(await page.getByRole('menuitem',{name:'Copy message',exact:true}).count(),0);
  const downloadPromise=page.waitForEvent('download');await page.getByRole('menuitem',{name:'Download attachment',exact:true}).click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),'report.pdf');
  await menu(fileRow);await page.getByRole('menuitem',{name:'Forward',exact:true}).click();const dialog=page.getByRole('dialog');await dialog.waitFor();
  await dialog.getByRole('searchbox').fill('group 1');await dialog.getByRole('button',{name:'Navigation group 1',exact:true}).click();await dialog.getByRole('button',{name:'Forward',exact:true}).click();await dialog.waitFor({state:'hidden'});
  const upload=await page.evaluate(()=>(window as any).forwardUploads[0]);assert.equal(upload.channelId,'g1');assert.equal(upload.name,'report.pdf');assert.equal(atob(upload.base64),'%PDF-1.7 original-file-bytes');console.log(JSON.stringify({draftAfterForward:await editor.innerText()}));assert.ok((await editor.innerText()).includes('Unsent draft remains'));
  await menu(textRow);await page.getByRole('menuitem',{name:'Forward',exact:true}).click();await dialog.getByRole('button',{name:'Navigation group 2',exact:true}).click();await dialog.getByRole('button',{name:'Forward',exact:true}).click();await dialog.waitFor({state:'hidden'});const text=await page.evaluate(()=>(window as any).forwardTexts[0]);assert.deepEqual(Object.keys(text).sort(),['channelId','clientMessageId','parts']);assert.equal(text.parts[0].text,'Message to forward');
  await menu(fileRow);await page.getByRole('menuitem',{name:'Forward',exact:true}).click();await dialog.getByRole('searchbox').fill('no matching conversation');await dialog.getByText('No available conversation').waitFor();assert.equal(await dialog.getByRole('button',{name:'Forward',exact:true}).isDisabled(),true);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.equal(await editor.innerText(),'Unsent draft remains');
  // Retry uses the same destination key; a failure must not consume the source draft.
  await menu(fileRow);await page.getByRole('menuitem',{name:'Forward',exact:true}).click();await dialog.getByRole('button',{name:'Navigation group 1',exact:true}).click();await page.evaluate(()=>(window as any).rejectForward=true);await dialog.getByRole('button',{name:'Forward',exact:true}).click();await dialog.getByRole('alert').waitFor();const failedKey=await page.evaluate(()=>(window as any).forwardUploads.at(-1).clientMessageId);await page.evaluate(()=>(window as any).rejectForward=false);await dialog.getByRole('button',{name:'Forward',exact:true}).click();await dialog.waitFor({state:'hidden'});assert.equal(await page.evaluate(()=>(window as any).forwardUploads.at(-1).clientMessageId),failedKey);
  // Keyboard invokes the same action menu, not a separate custom row.
  await textRow.focus();await textRow.press('Shift+F10');await page.getByRole('menuitem',{name:'Forward',exact:true}).waitFor();await page.keyboard.press('Escape');
  const imageRow=live.locator('[role=listitem]').filter({has:page.locator('.im-channel-chat__picture-frame')}).last();await menu(imageRow);await page.getByRole('menuitem',{name:'Copy image',exact:true}).click();await page.waitForTimeout(200);console.log(JSON.stringify({copyDialog:await page.getByRole('dialog').allTextContents(),feedback:await page.locator('.im-message-action-feedback').allTextContents()}));await page.waitForFunction(async()=>{try{return(await navigator.clipboard.read()).some(item=>item.types.includes('image/png'));}catch{return false;}});
  await menu(fileRow);await page.getByRole('menuitem',{name:'Forward',exact:true}).click();await dialog.getByRole('button',{name:'Navigation group 1',exact:true}).click();await page.screenshot({path:output+'/'+(touch?'touch':'mouse')+'-'+theme+'-forward.png'});const geometry=await dialog.evaluate(e=>({width:e.getBoundingClientRect().width,client:e.clientWidth,scroll:e.scrollWidth}));assert.ok(geometry.scroll<=geometry.client+1);await dialog.getByRole('button',{name:'Cancel',exact:true}).click();
  assert.deepEqual(errors,[]);results.push({touch,theme,originalFileForwarded:true,downloadOriginal:true,noFilenameCopy:true,textNoWake:true,emptySearch:true,draftRetained:true,retryKeyPreserved:true,imageClipboard:true,keyboardMenu:true});await context.close();
 }
 console.log(JSON.stringify({passed:true,results}));

}finally{await browser?.close();await server.close();}
