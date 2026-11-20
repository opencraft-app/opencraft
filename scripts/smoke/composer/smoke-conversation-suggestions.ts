import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {createServer} from 'vite';
import {chromium} from 'playwright';
const output=process.env.OPENCRAFT_SMOKE_OUTPUT??'/tmp/conversation-suggestions';await mkdir(output,{recursive:true});
const vite=await createServer({configFile:false,root:process.cwd(),logLevel:'error',esbuild:{jsx:'automatic'},resolve:{dedupe:['react','react-dom']},server:{host:'127.0.0.1',port:0},plugins:[{name:'fixture',configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/?'))return next();res.setHeader('Content-Type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/conversation-suggestions.tsx"></script>');});}}]});
await vite.listen();const browser=await chromium.launch({headless:true,executablePath:process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,args:['--no-sandbox']});const evidence=[];
try{for(const touch of [false,true])for(const theme of ['light','dark']){
 const context=await browser.newContext({viewport:{width:touch?390:1280,height:850},hasTouch:touch,isMobile:touch});
 const page=await context.newPage();await page.addInitScript(()=>{(window as any).__name=(v:any)=>v;});const errors:string[]=[];page.on('pageerror',e=>{errors.push(e.message);console.error(e.message)});page.on('console',m=>{if(m.type()==='error')console.error(m.text())});
 await page.goto(vite.resolvedUrls!.local[0]+'?theme='+theme+'&locale=zh-CN');const editor=page.locator('.ProseMirror');await editor.fill('@');
 await page.waitForFunction(()=>document.querySelectorAll('[role=option]').length===8);
 assert.equal(await page.evaluate(()=>(window as any).fixture.requests.length),1);
 await page.screenshot({path:output+'/'+theme+'-'+touch+'.png'});
 await editor.fill('@方案');await page.getByRole('option').first().filter({hasText:'方案 会话'}).waitFor();
 // File search is deliberately held: conversation choices must already work.
 assert.equal(await page.getByRole('option').count(),20);
 if(touch)await page.getByRole('option').first().tap();else await page.keyboard.press('Enter');
 assert.equal(await page.locator('[data-conversation-reference]').count(),1);
 assert.equal(await page.evaluate(()=>document.activeElement?.classList.contains('ProseMirror')),true);
 const prompt=await page.evaluate(()=>(window as any).fixture.prompt());assert.match(JSON.stringify(prompt),/opencraft:\/\/conversation\/v1\/fixture/);
 assert.equal(await page.evaluate(()=>(window as any).fixture.requests.some((r:any)=>!['discover','files'].includes(r.action))),false);
 await page.locator('[data-conversation-reference]').click();await page.getByText('Bounded preview',{exact:true}).waitFor();await page.keyboard.press('Escape');
 assert.equal(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.action==='read'&&r.bounded===true).length),1);
 await editor.fill('@a');await editor.fill('@ab');await editor.fill('@abc');await page.getByRole('option').first().filter({hasText:'abc 会话'}).waitFor();
 assert.deepEqual(await page.evaluate(()=>(window as any).fixture.requests.filter((r:any)=>r.action==='discover'&&/^a/.test(r.search)).map((r:any)=>r.search)),['abc']);
 // Chinese composition must suppress intermediate syllable queries.
 await editor.dispatchEvent('compositionstart');await editor.fill('@pinyin');await page.waitForTimeout(250);
 assert.equal(await page.evaluate(()=>(window as any).fixture.requests.some((r:any)=>r.search==='pinyin')),false);
 await editor.fill('@中文');await editor.dispatchEvent('compositionend');await page.getByRole('option').first().filter({hasText:'中文 会话'}).waitFor();
 await page.evaluate(()=>(window as any).fixture.holdRefs(true));await editor.fill('@旧');await page.waitForTimeout(230);await editor.fill('@新');await page.waitForTimeout(230);await page.evaluate(()=>(window as any).fixture.release());
 await page.getByRole('option').first().filter({hasText:'新 会话'}).waitFor();assert.equal(await page.getByRole('option').filter({hasText:'旧 会话'}).count(),0);
 assert.deepEqual(errors,[]);evidence.push({touch,theme,requests:await page.evaluate(()=>(window as any).fixture.requests)});await context.close();
}}finally{await browser.close();await vite.close();}
await writeFile(output+'/evidence.json',JSON.stringify(evidence,null,2));console.log('PASS desktop/touch light/dark recent/search/debounce/IME/stale/selection; no history reads until explicit bounded preview');
