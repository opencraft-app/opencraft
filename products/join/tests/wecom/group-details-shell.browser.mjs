import fs from'node:fs';import assert from'node:assert/strict';import{pathToFileURL}from'node:url';
const task=process.env.OPENCRAFT_SYNC_UI_OUTPUT??process.cwd()+'/.local/channel-recovery-evidence/',root=process.cwd();fs.mkdirSync(task,{recursive:true});
const{createServer}=await import(pathToFileURL(root+'/node_modules/vite/dist/node/index.js'));const{chromium}=await import(pathToFileURL(root+'/node_modules/playwright/index.mjs'));
import {groupDetailsShellSource as source} from './group-details-shell.fixture.mjs';
const server=await createServer({root,configFile:false,cacheDir:task+'vite',publicDir:root+'/apps/workbench-web/public',logLevel:'error',resolve:{dedupe:['react','react-dom','react-intl']},esbuild:{jsx:'automatic',target:'esnext'},server:{host:'127.0.0.1',port:0,hmr:false},optimizeDeps:{include:['prosemirror-state','prosemirror-view','prosemirror-model','prosemirror-transform','prosemirror-commands','prosemirror-history','prosemirror-keymap','prosemirror-inputrules','prosemirror-schema-list','@dnd-kit/core','@dnd-kit/sortable','@dnd-kit/utilities','react','react-dom','react-dom/client','react/jsx-runtime','motion/react','@tanstack/react-query','react-intl','@radix-ui/react-dialog','@radix-ui/react-dropdown-menu','@radix-ui/react-popover','@radix-ui/react-alert-dialog','tslib']},plugins:[{name:'navigation-probe',resolveId:id=>id==='/navigation-probe.tsx'?id:null,load:id=>id==='/navigation-probe.tsx'?source:null,configureServer(s){s.middlewares.use((req,res,next)=>{if(req.url?.startsWith('/@')||req.url?.startsWith('/node_modules')||req.url?.startsWith('/apps/')||req.url?.startsWith('/packages/')||req.url?.startsWith('/plugins/')||req.url?.startsWith('/navigation-probe.tsx')||req.url?.startsWith('/products/'))return next();if(req.headers.accept?.includes('text/html')){res.setHeader('content-type','text/html');res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/navigation-probe.tsx"></script>')}else next()})}}]});
let browser,activePage;
try {await server.listen();browser=await chromium.launch({headless:true,args:['--no-sandbox']});
for(const width of[320,390,430,1200])for(const theme of['light','dark']) {
const touch=width<600,context=await browser.newContext({viewport:{width,height:844},hasTouch:touch,isMobile:touch}),page=await context.newPage(),errors=[];activePage=page;page.setDefaultTimeout(10000);page.setDefaultNavigationTimeout(60000);page.on('pageerror',e=>errors.push(e.message));
await page.goto('http://127.0.0.1:'+server.httpServer.address().port+'/?theme='+theme);
await page.getByRole('button',{name:'Open Inbox',exact:true}).click();const live=page.locator('.page-stack__live');const group=live.getByRole('button',{name:'产品设计讨论组',exact:true});await group.waitFor();if(touch)await group.tap();else await group.click();
const entry=page.getByRole('button',{name:'群设置',exact:true});await entry.waitFor();await page.screenshot({path:task+'entry-'+width+'-'+theme+'.png'});if(touch)await entry.tap();else await entry.click();
await page.getByRole('heading',{name:'聊天信息 (3)',exact:true}).waitFor();await page.getByText(/^检查完成/).waitFor();assert.equal(await page.getByText('同步正常',{exact:true}).count(),0);assert.equal(await page.getByRole('textbox',{name:'群名称'}).count(),0);
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:task+'details-'+width+'-'+theme+'.png'});
await page.evaluate(()=>window.control.denyRemoval());await page.getByText(/部分修改尚未同步/).waitFor();
await page.getByRole('button',{name:/^企业微信连接/}).click();const section=page.getByRole('region',{name:'企业微信连接',exact:true});await section.waitFor();
assert.match(await section.textContent(),/移除成员未同步到企业微信/);assert.match(await section.textContent(),/群主权限/);
assert.match(await section.textContent(),/拉人、改名仍会分别/);assert.match(await section.textContent(),/检查更新不会重新执行/);
const check=section.getByRole('button',{name:'检查更新',exact:true});if(touch)await check.tap();else await check.click();
await page.waitForFunction(()=>window.control.checks===1);await section.getByText('部分修改尚未同步',{exact:true}).waitFor();
assert.equal(await section.getByText('同步正常',{exact:true}).count(),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
const issueBox=await section.locator('.im-channel-group-sync__delivery-issue').boundingBox(),sectionBox=await section.boundingBox(),updatedBox=await section.locator('.im-channel-group-sync__updated').boundingBox();
assert.ok(issueBox.width>=sectionBox.width-1,'delivery explanation must span both columns');assert.ok(issueBox.y>=updatedBox.y+updatedBox.height,'delivery explanation follows the check metadata');
await page.screenshot({path:task+'owner-denied-'+width+'-'+theme+'.png'});
await page.getByRole('button',{name:'返回',exact:true}).click();await page.getByRole('heading',{name:'聊天信息 (3)',exact:true}).waitFor();
assert.equal(await page.getByRole('button',{name:'添加成员',exact:true}).isEnabled(),true);
const nameEntry=page.getByRole('button',{name:/^群名称/});assert.equal(await nameEntry.isEnabled(),true);
// Focused permission campaign stops before unrelated rename-form focus checks.
if(process.env.OPENCRAFT_GROUP_PERMISSION_ONLY==='1'){
 await page.evaluate(()=>window.control.resolveRemoval());await page.getByText(/^检查完成/).waitFor();
 await page.getByRole('button',{name:'关闭',exact:true}).click();await entry.waitFor();assert.deepEqual(errors,[]);
 console.log(JSON.stringify({width,theme,actualShell:true,actualChatEntry:true,tap:touch,ownerDeniedPerAction:true,checkDoesNotClearFailure:true,addAndRenameRemainEnabled:true,provider:'simulated',noProviderWrites:true}));await context.close();continue;
}
if(touch)await nameEntry.tap();else await nameEntry.click();
await page.getByRole('heading',{name:'修改群名',exact:true}).waitFor();const nameInput=page.getByRole('textbox',{name:'群名称',exact:true});assert.equal(await nameInput.evaluate(el=>el===document.activeElement&&el.selectionStart===0&&el.selectionEnd===el.value.length),true);assert.equal(await page.getByRole('button',{name:'保存',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('dialog').count(),1);
await page.screenshot({path:task+'rename-'+width+'-'+theme+'.png'});await nameInput.fill('产品设计新讨论组');await page.setViewportSize({width,height:380});await nameInput.focus();await page.screenshot({path:task+'rename-keyboard-'+width+'-'+theme+'.png'});await page.getByRole('button',{name:'取消',exact:true}).click();assert.equal(await nameEntry.evaluate(el=>el===document.activeElement),true);await page.setViewportSize({width,height:844});
await page.getByRole('button',{name:'完成',exact:true}).click();await entry.waitFor();assert.deepEqual(errors,[]);console.log(JSON.stringify({width,theme,actualShell:true,actualChatEntry:true,tap:touch,checksOnlyHonest:true,ownerDeniedPerAction:true,checkDoesNotClearFailure:true,focusRestored:await entry.evaluate(el=>el===document.activeElement)}));await context.close();
}
}catch(error){await activePage?.screenshot({path:task+"failure.png"}).catch(()=>{});fs.writeFileSync(task+"failure.txt",await activePage?.locator("body").innerText().catch(()=>"")??"");throw error;}finally{await browser?.close();await server.close();}
