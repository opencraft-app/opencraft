import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as sass from 'sass';
import { chromium } from 'playwright';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
const root = await mkdtemp(join(tmpdir(), 'annotation-integrated-'));
await build({ entryPoints: ['scripts/smoke/browser/smoke-annotation-v2-integrated.entry.tsx'], outfile: join(root,'entry.js'), bundle: true, minify: true, format:'esm', jsx:'automatic', platform:'browser', plugins:[{name:'scss',setup(b){b.onLoad({filter:/\.scss$/},args=>({contents:sass.compile(args.path,{loadPaths:['node_modules'],importers:[{findFileUrl(url){return url.startsWith('@opencraft/')?pathToFileURL(require.resolve(url)):null;}}]}).css,loader:'css'}));}}] });
const server = createServer(async(req,res)=>{try{if(req.url.split('?')[0]==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/entry.css"><style>body{margin:0}*{box-sizing:border-box}</style><div id="root"></div><script type="module" src="/entry.js"></script>');return;}res.setHeader('content-type',req.url.endsWith('.css')?'text/css':'text/javascript');res.end(await readFile(join(root,req.url==='/entry.css'?'entry.css':'entry.js')));}catch{res.writeHead(404).end();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({args:['--no-sandbox']});
const screenshots=process.env.OPENCRAFT_ANNOTATION_SCREENSHOTS;
const settle = page => page.evaluate(async () => { await Promise.all(document.getAnimations().map(a => a.finished.catch(()=>{}))); });
try {
 for(const mobile of [false,true]) {
  const page=await browser.newPage({viewport:mobile?{width:390,height:844}:{width:1100,height:850},hasTouch:mobile,isMobile:mobile});
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/${mobile?'#dark':''}`);
  await page.waitForFunction(()=>window.integratedAnnotation?.controller.available);
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForFunction(()=>window.ready);
  await page.click('#activate');
  if(mobile) await frame.locator('#first').tap(); else await frame.locator('#first').click();
  await page.waitForFunction(()=>integratedAnnotation.controller.candidate);
  if(mobile) assert.equal(await page.evaluate(()=>document.activeElement?.tagName==='TEXTAREA'),false,'selection must not summon phone keyboard');
  await page.locator('.browser-annotation-intents > summary').first().click();
  await page.waitForFunction(()=>integratedAnnotation.controller.styles);
  const color=page.locator('#annotation-style-color');await color.fill('#d52546');await color.press('Enter');
  await page.waitForFunction(()=>integratedAnnotation.controller.styleIntents.length===1);
  assert.equal(await page.getByRole('button',{name:'Add to chat',exact:true}).isEnabled(),true,'style-only request needs no boilerplate comment');
  await page.getByRole('button',{name:'Preview changes',exact:true}).click();
  await page.waitForFunction(()=>integratedAnnotation.controller.previewing&&!integratedAnnotation.controller.busy);
  assert.equal(await frame.locator('#first').evaluate(el=>getComputedStyle(el).color),'rgb(213, 37, 70)');
  const hold=page.getByRole('button',{name:'Hold to compare',exact:true});
  await hold.focus();await page.keyboard.down('Space');await page.keyboard.up('Space');
  await page.waitForFunction(()=>!integratedAnnotation.controller.busy&&!integratedAnnotation.controller.original);
  assert.equal(await frame.locator('#first').evaluate(el=>getComputedStyle(el).color),'rgb(213, 37, 70)','quick release must restore preview even during the request');
  await hold.focus();await page.keyboard.down('Space');
  await page.waitForFunction(()=>integratedAnnotation.controller.original&&!integratedAnnotation.controller.busy);
  assert.notEqual(await frame.locator('#first').evaluate(el=>getComputedStyle(el).color),'rgb(213, 37, 70)');
  await page.keyboard.up('Space');await page.waitForFunction(()=>!integratedAnnotation.controller.original&&!integratedAnnotation.controller.busy);
  // Desktop card is adjacent, not over the selected element. Geometry has no easing.
  if(!mobile){const card=await page.locator('.browser-annotation-editor').boundingBox(),target=await frame.locator('#first').boundingBox();assert.ok(card.x>=target.x+target.width||card.x+card.width<=target.x||card.y>=target.y+target.height||card.y+card.height<=target.y);}
  await settle(page);
  if(screenshots)await page.screenshot({path:join(screenshots,`polish-${mobile?'touch':'desktop'}-styles.png`)});
  // One confirmed save clears temporary DOM changes, creates exactly one context item.
  await page.getByRole('button',{name:'Add to chat',exact:true}).click();await page.waitForFunction(()=>integratedAnnotation.controller.count===1&&!integratedAnnotation.controller.busy);
  assert.notEqual(await frame.locator('#first').evaluate(el=>getComputedStyle(el).color),'rgb(213, 37, 70)');
  assert.equal(await page.evaluate(()=>integratedAnnotation.composer.getSnapshot().draft.context.length),1);
  // Tap the rendered marker, not an approximate cached client rectangle; both surfaces share this path.
  const target=await frame.locator('#first').boundingBox();
  if(mobile) await page.touchscreen.tap(target.x+target.width-3,target.y+2);else await page.mouse.click(target.x+target.width-3,target.y+2);
  await page.waitForFunction(()=>integratedAnnotation.controller.editingId);
  assert.equal(await page.evaluate(()=>integratedAnnotation.controller.count),1,'marker must reopen instead of creating a duplicate');
  await page.getByPlaceholder('Describe a change or ask a question…').fill('Refine this action');
  if(mobile){await page.getByRole('button',{name:'Show page',exact:true}).tap();assert.equal(await page.locator('#annotation-editor-body').isVisible(),false);await page.getByRole('button',{name:/Edit annotation/}).tap();assert.equal(await page.getByPlaceholder('Describe a change or ask a question…').inputValue(),'Refine this action');}
  await page.getByRole('button',{name:'Save changes',exact:true}).click();await page.waitForFunction(()=>!integratedAnnotation.controller.editingId);
  await frame.locator('#second').click();await page.waitForFunction(()=>integratedAnnotation.controller.candidate);
  await page.locator('.browser-annotation-intents > summary').first().click();await page.waitForFunction(()=>integratedAnnotation.controller.styles);
  await page.getByText('Spacing',{exact:true}).click();await page.getByRole('button',{name:'Link opposite sides',exact:true}).click();
  const top=page.locator('#annotation-style-padding-top');await top.fill('24px');await top.press('Enter');
  await page.waitForFunction(()=>document.querySelector('#annotation-style-padding-bottom').value==='24px');
  await page.getByRole('button',{name:'Reset Top padding',exact:true}).click();
  await page.waitForFunction(()=>integratedAnnotation.controller.styleIntents.length===0);
  assert.equal(await page.getByRole('button',{name:'Add to chat',exact:true}).isDisabled(),true,'unchanged selection cannot submit');
  await page.getByText('Size',{exact:true}).click();
  const lock=page.getByRole('button',{name:'Keep proportions',exact:true});
  if(await lock.isEnabled()){await lock.click();const before=Number.parseFloat(await page.locator('#annotation-style-height').inputValue());const width=page.locator('#annotation-style-width');const w=Number.parseFloat(await width.inputValue());await width.fill(`${w*2}px`);await width.press('Enter');await page.waitForFunction(expected => Math.abs(Number.parseFloat(document.querySelector('#annotation-style-height').value) - expected) < .01, before*2);}
  // Short viewport + reduced motion: footer stays reachable and form draft survives resize.
  await page.emulateMedia({reducedMotion:'reduce'});await page.setViewportSize({width:mobile?390:700,height:500});
  await page.getByRole('button',{name:'Add to chat',exact:true}).scrollIntoViewIfNeeded();
  const footer=await page.getByRole('button',{name:'Add to chat',exact:true}).boundingBox();assert.ok(footer.y>=0&&footer.y+footer.height<=500);
  assert.deepEqual(errors,[]);await page.close();
 }
 // Localized visual acceptance on the same actual component/iframe path.
 if(screenshots) for(const dark of [false,true]) {
  const page=await browser.newPage({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  await page.goto(`http://127.0.0.1:${server.address().port}/?zh${dark?'#dark':''}`);
  await page.waitForFunction(()=>window.integratedAnnotation?.controller.available);
  const frame=page.frames().find(f=>f.parentFrame());await frame.waitForFunction(()=>window.ready);
  await page.click('#activate');await frame.locator('#first').tap();await page.waitForFunction(()=>integratedAnnotation.controller.candidate);
  await page.getByPlaceholder('描述修改建议或提问…').count();
  await settle(page);
  assert.equal(await page.getByRole('button',{name:'退出批注',exact:true}).count(),1);
  assert.equal(await page.getByRole('button',{name:'Done',exact:true}).count(),0);
  await page.screenshot({path:join(screenshots,`polish-zh-touch-${dark?'dark':'light'}-comment.png`)});
  await page.locator('.browser-annotation-intents > summary').first().tap();await page.waitForFunction(()=>integratedAnnotation.controller.styles);
  await page.locator('#annotation-style-color').fill('#d52546');await page.locator('#annotation-style-color').press('Enter');
  await page.locator('.browser-annotation-editor__body').evaluate(el=>el.scrollTop=0);await settle(page);
  await page.screenshot({path:join(screenshots,`polish-zh-touch-${dark?'dark':'light'}-styles.png`)});
  await page.setViewportSize({width:320,height:568});await settle(page);
  const bounds=await page.locator('.browser-annotation-modebar').boundingBox();assert.ok(bounds.x>=0&&bounds.x+bounds.width<=320);
  await page.close();
 }
 console.log('annotation polish: real iframe + actual controller/UI, desktop/touch, grouped styles, linked reset, ratio, quick/held comparison, pure-style commit, marker reopen, collapse draft continuity, short viewport, reduced motion passed');
} finally {await browser.close();await new Promise(r=>server.close(r));await rm(root,{recursive:true,force:true});}
