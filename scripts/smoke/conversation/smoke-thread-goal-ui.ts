import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "vite";

const output = await mkdtemp(join(tmpdir(), "opencraft-goal-ui-"));
const source = `
import React,{useState} from 'react';
import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
bindTouchInteractionMode(document);
import {createRoot} from 'react-dom/client';
import {OpenCraftComposer} from '@opencraft/composer-editor';
import {createComposerController} from '@opencraft/composer-core';
import {FormattedMessage} from '@opencraft/i18n/react';
import {MemoryUiPreferenceStore,UiPreferencesRuntime} from '@opencraft/ui-preferences';
import {UiPreferencesProvider} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
import {WorkbenchLocaleController,WorkbenchIntlProvider} from '/apps/workbench-web/src/i18n/workbench-locale.tsx';
const preferences=await UiPreferencesRuntime.open({installation:new MemoryUiPreferenceStore()});
const locale=new WorkbenchLocaleController(preferences);
await locale.initialize();
import * as DropdownMenu from '@opencraft/design-system-web/dropdown-menu';
import {NewThreadDraftPage} from '/apps/workbench-web/src/components/new-thread-draft-page.tsx';
import {createNewThreadGoalFlow} from '/apps/workbench-web/src/runtime/new-thread-goal.ts';
import {FloatingComposerRegistryContext} from '/apps/workbench-web/src/components/thread-composer-presentation.tsx';
import {FloatingComposerRegistry} from '/apps/workbench-web/src/components/floating-composer-state.ts';
import {createConversationScopeRegistry} from '@opencraft/workbench-runtime';
import {TurnDiffBlock} from '/apps/workbench-web/src/components/conversation/turn-diff-resource.tsx';
import {queuedSubmissionPresentation} from '/apps/workbench-web/src/queued-submission-presentation.ts';
import {ThreadGoalSurface} from '/apps/workbench-web/src/components/thread-goal-surface.tsx';
import {ThreadGoalResource} from '/packages/workbench-runtime/src/thread-goal-resource.ts';
import {buildOpenCraftThemeCssProperties,opencraftCanvasThemePalette,lavenderThemePalette} from '/packages/design-system/src/theme-engine.ts';
import '/apps/workbench-web/src/styles/app.scss';
import '@fontsource-variable/noto-sans-sc';
Object.entries(buildOpenCraftThemeCssProperties('light',opencraftCanvasThemePalette.light)).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));
const queued=queuedSubmissionPresentation({commandId:'queue',clientMessageId:'client',serverSubmissionId:'server',input:[],preview:'检查并保留这份排队输入',operation:'idle',createdAt:100,pausedReason:null,error:null,state:'queued'},true);
const diff={id:'diff',type:'turn-diff',sourceItemIds:['diff'],status:'running',unifiedDiff:'',additions:36,deletions:8,files:[{path:'goal-ui.tsx',additions:36,deletions:8}]};
const initialGoal={threadId:'one',objective:'完成移动端目标体验，验证离开页面后仍能持续推进。',status:new URLSearchParams(location.search).has('completed')?'complete':'active',tokenBudget:null,tokensUsed:312,timeUsedSeconds:1139760,createdAt:Math.floor(Date.now()/1000)-82,updatedAt:Math.floor(Date.now()/1000)};
let composerRenders=0,accounting=true,goal=initialGoal,write=true,setCalls=0,clearCalls=0,lastChange=null,submitted=0;
const goals=new ThreadGoalResource({capability:()=>({version:1,read:true,write,...(!accounting?{usageAccounting:false}:{})}),get:async()=>({goal}),set:async(id,change)=>{setCalls++;lastChange=change;if(failWrite)throw Error('synthetic failure');goal=goal?{...goal,...change,threadId:id,updatedAt:Math.floor(Date.now()/1000)}:{...initialGoal,...change,threadId:id,tokensUsed:0,timeUsedSeconds:0,createdAt:Math.floor(Date.now()/1000),updatedAt:Math.floor(Date.now()/1000)};return {goal}},clear:async()=>{clearCalls++;goal=null;return {cleared:true}}});
const controller=createComposerController({type:'existing-thread',key:{hostId:'fixture',threadId:'one'}},{now:Date.now,createId:()=>crypto.randomUUID()});
const scopes=createConversationScopeRegistry();
const draft=scopes.openDraft({draftId:'new-goal-draft',execution:{hostId:'fixture',workspace:{cwd:'/project',runtimeWorkspaceRoots:['/project']}}});
const draftController=createComposerController(draft.target,{now:Date.now,createId:()=>crypto.randomUUID()});
const floatingRegistry=new FloatingComposerRegistry();
let creates=0,opens=0,failWrite=false,releaseCreate=null,holdCreate=false,connection='ready';
const newGoals=new ThreadGoalResource({capability:()=>({version:1,read:true,write,...(!accounting?{usageAccounting:false}:{})}),get:async()=>({goal}),set:async(id,change)=>{setCalls++;if(failWrite)throw Error('synthetic failure');goal={...initialGoal,...change,threadId:id};return {goal}},clear:async()=>({cleared:true})});
function App(){const[threadId,setThreadId]=useState('one');const[newDraft,setNewDraft]=useState(false);const[tick,setTick]=useState(0);const[extras,setExtras]=useState(false);
const startGoal=React.useMemo(()=>createNewThreadGoalFlow({createThread:async()=>{creates++;if(holdCreate)await new Promise(resolve=>releaseCreate=resolve);return {hostId:'fixture',threadId:'created',turnId:null}},goals:()=>newGoals,openThread:async()=>{opens++;setThreadId('created');setNewDraft(false)}}),[]);
window.fixture={composerRenders:()=>composerRenders,accounting:value=>{accounting=value;goals.observe(threadId,goal)},setExtras:setExtras,setCapacity:width=>document.documentElement.style.setProperty('--probe-capacity',width+'px'),setPalette:(mode,palette)=>Object.entries(buildOpenCraftThemeCssProperties(mode,(palette==='lavender'?lavenderThemePalette:opencraftCanvasThemePalette)[mode])).forEach(([key,value])=>document.documentElement.style.setProperty(key,value)),setLocale:value=>preferences.set('locale.override',value),localeOverride:()=>preferences.get('locale.override'),setGoal:change=>{goal={...initialGoal,...change};goals.observe(threadId,goal)},beginDraft:()=>{goal=null;connection='ready';write=true;setNewDraft(true)},creates:()=>creates,opens:()=>opens,failWrite:value=>failWrite=value,holdCreate:()=>holdCreate=true,releaseCreate:()=>{holdCreate=false;releaseCreate?.()},connection:value=>{connection=value;setTick(value=>value+1)},draftReadonly:value=>{write=!value;setTick(value=>value+1)},draftText:()=>draftController.getSnapshot().draft.document.blocks,setTheme:mode=>Object.entries(buildOpenCraftThemeCssProperties(mode,opencraftCanvasThemePalette[mode])).forEach(([key,value])=>document.documentElement.style.setProperty(key,value)),clear:()=>{goal=null;goals.observe(threadId,null)},readonly:value=>{write=!value;goals.observe(threadId,goal)},switchThread:value=>setThreadId(value),threadId:()=>threadId,goalPhase:()=>goals.getSnapshot(threadId).phase,setCalls:()=>setCalls,clearCalls:()=>clearCalls,lastChange:()=>lastChange,status:()=>goal?.status,submitted:()=>submitted,objective:()=>goal?.objective,completedObjective:()=>goals.getSnapshot(threadId).completedGoal?.objective,goalUsage:()=>({tokensUsed:goal?.tokensUsed,timeUsedSeconds:goal?.timeUsedSeconds})};
if(newDraft)return <FloatingComposerRegistryContext.Provider value={floatingRegistry}><NewThreadDraftPage draft={draft} controller={draftController} goals={newGoals} onCreateGoal={objective=>{const content=draftController.getSnapshot().draft;return startGoal({...content,target:draft.target,commandId:crypto.randomUUID(),clientMessageId:crypto.randomUUID(),createdAt:Date.now(),document:{version:1,blocks:[{type:'paragraph',children:[{type:'text',text:objective}]}]}},objective,()=>true)}} showExecutionControls={false} workspaceOptions={[]} activeHostId='fixture' hostOptions={[]} connectionPhase={connection} onSelectHost={()=>{}} onSelectWorkspace={()=>{}} onBrowseWorkspace={()=>{}} selectionCatalog={{models:[{id:'model',value:'model',label:'Model',description:null,isDefault:true,defaultEffort:null,efforts:[]}],permissionProfiles:[]}} catalog={{}} onSubmit={()=>{throw Error('Goal must not send ordinary input')}} /></FloatingComposerRegistryContext.Provider>;
return <div style={{height:'100dvh',display:'flex',flexDirection:'column',justifyContent:'flex-end',width:'min(100%,var(--probe-capacity,100%))',marginInline:'auto',padding:'20px 16px 32px',background:'var(--color-background-surface)'}}><ThreadGoalSurface threadId={threadId} goals={goals}>{(goalMenuItem,_busy,goalContent)=>(composerRenders++,<OpenCraftComposer attachedContent={goalContent} floatingContent={extras?<div className='thread-live-changes'><TurnDiffBlock block={diff}/></div>:null} queuedSubmissions={extras?[queued]:[]} controller={controller} selectionCatalog={{models:[{id:'model',value:'model',label:'Model',description:null,isDefault:true,defaultEffort:null,efforts:[]}],permissionProfiles:[]}} onSubmit={async()=>{submitted++}} onCancel={()=>{}} addMenuContent={closeMenu=><><DropdownMenu.Item className='opencraft-composer-selection-menu__item opencraft-composer-add-menu__item'><FormattedMessage id='connector.title' defaultMessage='Connectors'/></DropdownMenu.Item>{goalMenuItem?.(closeMenu)}</>}/>)}</ThreadGoalSurface></div>}
createRoot(document.getElementById('root')).render(<UiPreferencesProvider runtime={preferences}><WorkbenchIntlProvider controller={locale} target={document.documentElement}><App/></WorkbenchIntlProvider></UiPreferencesProvider>);
`;
const vite = await createServer({
  configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom", "react-intl"] },
  cacheDir: "node_modules/.vite-thread-goal-ui",
  optimizeDeps: { entries: [], noDiscovery: true, include: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react/jsx-dev-runtime", "react-intl", "@radix-ui/react-dialog", "@radix-ui/react-dropdown-menu", "@radix-ui/react-popover"] },
  esbuild: { jsx: "automatic" }, server: { host: "127.0.0.1", port: 0, hmr: false },
  plugins: [{ name: "goal-ui-fixture", resolveId: id => id === "/goal-probe.tsx" ? id : null,
    load: id => id === "/goal-probe.tsx" ? source : null,
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url?.split("?")[0] !== "/") return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/goal-probe.tsx"></script>');
    }); },
  }],
});
let browser;
try {
  await vite.listen();
  if (process.argv.includes("--serve")) {
    console.log(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
    await new Promise<void>(() => undefined);
  }
  const playwright = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
  const { chromium } = playwright.default ?? playwright;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "zh-CN" });
  page.setDefaultTimeout(10000);
  page.setDefaultNavigationTimeout(60000);
  const errors: string[] = [];
  page.on("pageerror", (error: Error) => { errors.push(error.message); console.error(error.message); });
  await page.addInitScript("window.__name = value => value");
  await page.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  const summary = page.getByRole("button", { name: /正在推进目标/ });
  const openGoalEditor = async () => {
    const edit = page.locator('.thread-goal__edit');
    if (await edit.isVisible()) await edit.click();
    else {
      await page.getByRole('button', { name: '目标操作', exact: true }).click();
      await page.getByRole('menuitem', { name: '编辑', exact: true }).click();
    }
  };
  await summary.waitFor();
  assert.equal(await page.evaluate(() => (window as any).fixture.localeOverride()), "");
  assert.equal(await page.locator(".thread-goal__time").getAttribute("title"), "13 天 4 小时 36 分钟");
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
    await summary.click();
    await page.screenshot({ path: `${output}/${mode}-expanded.png` });
    const colors = await summary.evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.notEqual(colors.color, colors.background);
    assert.equal(await page.locator('.thread-goal').evaluate(el => el.parentElement?.classList.contains('opencraft-composer-attached-rail')), true);
    await page.keyboard.press('Escape');
    await page.locator('.thread-goal__detail').waitFor({state:'hidden'});
    await page.waitForFunction(() => document.activeElement?.classList.contains('thread-goal__summary'));
    assert.equal(await summary.evaluate(el => el === document.activeElement), true);
    await openGoalEditor();
    const dialog = page.getByRole("dialog", { name: "编辑目标" });
    await dialog.waitFor();
    await page.screenshot({ path: `${output}/${mode}-editor.png` });
    const box = await dialog.boundingBox();
    assert.ok(box && box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844);
    const titleBox = await dialog.locator(".thread-goal__editor h2").boundingBox();
    assert.ok(titleBox && titleBox.x >= box.x + 15);
    const saveColors = await dialog.getByRole("button", { name: "保存" }).evaluate(element => ({ color: getComputedStyle(element).color, background: getComputedStyle(element).backgroundColor }));
    assert.notEqual(saveColors.color, saveColors.background);
    await dialog.getByRole("button", { name: "取消" }).click();
  }
  assert.deepEqual(errors, []);
  const add = page.getByRole("button", { name: "添加", exact: true });
  const create = page.getByRole("menuitem", { name: "设定持续目标", exact: true });
  const editor = page.locator(".opencraft-composer-editor");
  await editor.fill("保留这份输入草稿");
  await page.evaluate(() => (window as any).fixture.clear());
  await summary.waitFor({ state: "hidden" });
  assert.equal(await page.locator(".thread-goal").count(), 0);
  assert.equal(await page.getByRole("button", { name: "设定持续目标", exact: true }).count(), 0);
  for (const mode of ["light", "dark"] as const) {
    await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
    await add.tap();
    await create.waitFor();
    assert.equal(await page.getByRole("menuitem", { name: "添加附件", exact: true }).count(), 1);
    assert.equal(await page.getByRole("menuitem", { name: "连接器", exact: true }).count(), 1);
    await page.screenshot({ path: `${output}/${mode}-add-menu.png` });
    await create.tap();
    const dialog = page.getByRole("dialog", { name: "设定持续目标", exact: true });
    await dialog.waitFor();
    await page.waitForFunction(() => document.querySelector('[role="dialog"]')?.contains(document.activeElement));
    assert.equal(await page.getByRole("menu").count(), 0);
    await dialog.getByRole("textbox", { name: "目标内容" }).fill("取消不会创建目标");
    await dialog.getByRole("button", { name: "取消" }).tap();
    assert.equal(await page.evaluate(() => (window as any).fixture.setCalls()), 0);
    assert.equal(await editor.innerText(), "保留这份输入草稿");
  }
  await add.focus();
  await page.keyboard.press("Enter");
  await create.waitFor();
  await page.waitForFunction(() => document.activeElement?.getAttribute("role") === "menuitem");
  await page.keyboard.press("End");
  await page.waitForFunction(() => document.activeElement?.textContent === "设定持续目标");
  await page.keyboard.press("Enter");
  const createDialog = page.getByRole("dialog", { name: "设定持续目标", exact: true });
  await createDialog.waitFor();
  await createDialog.getByRole("textbox", { name: "目标内容" }).fill("从菜单创建的持续目标");
  await createDialog.getByRole("button", { name: "保存" }).tap();
  await createDialog.waitFor({ state: "hidden" });
  await summary.waitFor();
  assert.match((await page.locator(".thread-goal__time").getAttribute("title"))!, /^\d+ 秒$/);
  assert.equal(await page.evaluate(()=>(window as any).fixture.goalUsage().timeUsedSeconds),0);
  assert.equal(await page.evaluate(() => (window as any).fixture.objective()), "从菜单创建的持续目标");
  assert.equal(await page.evaluate(() => (window as any).fixture.setCalls()), 1);
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape"); await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.evaluate(() => { (window as any).fixture.clear(); (window as any).fixture.readonly(true); });
  await summary.waitFor({ state: "hidden" });
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape"); await page.getByRole("menu").waitFor({ state: "hidden" });
  await page.evaluate(() => (window as any).fixture.readonly(false));
  await add.tap();
  await create.tap();
  await createDialog.waitFor();
  await createDialog.getByRole("textbox", { name: "目标内容" }).fill("旧会话未保存目标");
  const originalEditor = await editor.elementHandle();
  await page.evaluate(() => (window as any).fixture.switchThread("two"));
  await createDialog.waitFor({ state: "hidden" });
  assert.equal(await originalEditor?.evaluate(element => element.isConnected), true);
  assert.equal(await editor.innerText(), "保留这份输入草稿");
  await add.tap();
  await create.tap();
  await createDialog.waitFor();
  assert.equal(await createDialog.getByRole("textbox", { name: "目标内容" }).inputValue(), "");
  await createDialog.getByRole("button", { name: "取消" }).tap();
  await page.evaluate(() => (window as any).fixture.switchThread(null));
  await add.tap();
  assert.equal(await create.count(), 0);
  await page.keyboard.press("Escape"); await page.getByRole("menu").waitFor({ state: "hidden" });
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    await page.evaluate(() => (window as any).fixture.beginDraft());
    await page.locator('[data-new-thread-draft-id]').waitFor();
    console.log('new Draft', width);
    const draftEditor = page.locator('.opencraft-composer-editor');
    await draftEditor.fill('保留新会话的普通输入');
    for (const mode of ['light', 'dark'] as const) {
      await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
      console.log('new Goal dialog', width, mode);
      await add.click(); await create.click(); await createDialog.waitFor();
      const start = createDialog.getByRole('button', { name: '开始目标' });
      assert.equal(await start.isDisabled(), true);
      await createDialog.getByRole('textbox', { name: '目标内容' }).fill('新会话直接开启目标');
      await page.screenshot({ path: `${output}/${mode}-new-goal-${width}.png` });
      const box = await createDialog.boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width && box.y >= 0 && box.y + box.height <= 844);
      await createDialog.getByRole('button', { name: '取消' }).click();
      await createDialog.waitFor({ state: 'hidden' });
      assert.equal(await page.evaluate(() => (window as any).fixture.creates()), 0);
      assert.equal(await draftEditor.innerText(), '保留新会话的普通输入');
    }
    await page.evaluate(() => (window as any).fixture.draftReadonly(true));
    await add.click(); assert.equal(await create.count(), 0); await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
    await page.evaluate(() => { (window as any).fixture.draftReadonly(false); (window as any).fixture.connection('reconnecting'); });
    await add.click(); assert.equal(await create.isDisabled(), true); await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
    await page.evaluate(() => (window as any).fixture.connection('ready'));
  }
  await add.focus(); await page.keyboard.press('Enter'); await create.waitFor();
  await create.focus();
  await page.keyboard.press('Enter'); await createDialog.waitFor();
  await createDialog.getByRole('textbox', { name: '目标内容' }).fill('新会话直接开启目标');
  await page.evaluate(() => { (window as any).fixture.failWrite(true); (window as any).fixture.holdCreate(); });
  const start = createDialog.getByRole('button', { name: '开始目标' });
  console.log('starting new Goal');
  await start.click();
  await page.waitForFunction(() => (window as any).fixture.creates() === 1);
  assert.equal(await start.isDisabled(), true);
  assert.equal(await createDialog.getByRole('button', { name: '取消' }).isDisabled(), true);
  await page.evaluate(() => (window as any).fixture.releaseCreate());
  await createDialog.getByRole('alert').waitFor();
  await page.evaluate(() => (window as any).fixture.setLocale('en-US'));
  await page.getByRole('dialog', {name:'Set a goal',exact:true}).getByRole('alert').filter({hasText:'The action could not be completed. Please try again.'}).waitFor();
  await page.evaluate(() => (window as any).fixture.setLocale(''));
  await createDialog.getByRole('alert').filter({hasText:'操作未完成，请重试。'}).waitFor();
  assert.equal(await createDialog.getByRole('textbox', { name: '目标内容' }).inputValue(), '新会话直接开启目标');
  await page.evaluate(() => (window as any).fixture.failWrite(false));
  console.log('retrying new Goal');
  await start.click(); await createDialog.waitFor({ state: 'hidden' }); await summary.waitFor();
  assert.equal(await page.evaluate(() => (window as any).fixture.creates()), 1);
  assert.equal(await page.evaluate(() => (window as any).fixture.opens()), 1);
  assert.equal(await page.evaluate(() => (window as any).fixture.objective()), '新会话直接开启目标');
  assert.match(JSON.stringify(await page.evaluate(() => (window as any).fixture.draftText())), /保留新会话的普通输入/);
  assert.deepEqual(errors, []);
  // Existing language preference updates the mounted dialog and preserves its draft.
  await openGoalEditor();
  const editDialog = page.getByRole('dialog', { name: '编辑目标', exact: true });
  const objective = editDialog.getByRole('textbox', { name: '目标内容' });
  await objective.fill('用户输入不翻译 / keep this draft');
  const originalObjective = await objective.elementHandle();
  await page.evaluate(() => (window as any).fixture.setLocale('en-US'));
  const englishDialog = page.getByRole('dialog', { name: 'Edit goal', exact: true });
  await englishDialog.waitFor();
  assert.equal(await englishDialog.getByRole('textbox', { name: 'Goal objective' }).inputValue(), '用户输入不翻译 / keep this draft');
  assert.equal(await originalObjective?.evaluate(el => el.isConnected && el === document.activeElement), true);
  assert.equal(await englishDialog.getByRole('button', { name: 'Save', exact: true }).count(), 1);
  await page.screenshot({ path: `${output}/en-US-live-editor.png` });
  await englishDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.evaluate(() => (window as any).fixture.setGoal({status:'paused',tokenBudget:12345,tokensUsed:1234,timeUsedSeconds:1139760}));
  const englishSummary = page.getByRole('button', { name: /Goal paused/ });
  await englishSummary.waitFor();
  assert.equal(await page.locator('.thread-goal__time').getAttribute('title'), '13 days 4 hours 36 minutes');
  await englishSummary.click();
  await page.locator('.thread-goal__detail small').filter({hasText:'Used 1,234 / 12,345'}).waitFor();
  for (const [status, label] of Object.entries({active:'Pursuing goal',paused:'Goal paused',blocked:'Goal needs help',usageLimited:'Goal usage limit reached',budgetLimited:'Goal budget limit reached'})) {
    await page.evaluate(status => (window as any).fixture.setGoal({status}), status);
    await page.locator('.thread-goal__label').filter({hasText:label}).waitFor();
  }
  for (const [seconds, expected] of [[1,'1 second'],[60,'1 minute'],[3600,'1 hour 0 minutes'],[86400,'1 day 0 hours 0 minutes']] as const) {
    await page.evaluate(timeUsedSeconds => (window as any).fixture.setGoal({status:'paused',timeUsedSeconds,tokenBudget:12345,tokensUsed:1234}), seconds);
    assert.equal(await page.locator('.thread-goal__time').getAttribute('title'), expected);
  }
  // English source messages also serve locales without an application catalog.
  await page.evaluate(() => (window as any).fixture.setLocale('de-DE'));
  await page.locator('.thread-goal__detail small').filter({hasText:'Used 1.234 / 12.345'}).waitFor();
  await page.keyboard.press('Escape'); await page.locator('.thread-goal__detail').waitFor({state:'hidden'});
  await page.evaluate(() => (window as any).fixture.clear());
  const englishAdd = page.getByRole('button', { name: 'Add', exact: true });
  await englishAdd.click();
  await page.getByRole('menuitem', { name: 'Set a goal', exact: true }).waitFor();
  assert.equal(await page.getByRole('menuitem', { name: '设定持续目标', exact: true }).count(), 0);
  await page.screenshot({ path: `${output}/en-US-goal-menu.png` });
  await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({ state: 'hidden' });
  await page.evaluate(() => (window as any).fixture.setLocale(''));
  await add.click();
  await create.waitFor();
  assert.equal(await page.evaluate(() => (window as any).fixture.localeOverride()), '', 'automatic mode must keep the existing empty override');
  await create.click(); await createDialog.waitFor();
  await createDialog.getByRole('textbox', { name: '目标内容' }).fill('自动跟随系统语言');
  await page.evaluate(() => (window as any).fixture.setLocale('en-US'));
  const englishCreate = page.getByRole('dialog', { name: 'Set a goal', exact: true });
  await englishCreate.waitFor();
  assert.equal(await englishCreate.getByRole('textbox', { name: 'Goal objective' }).inputValue(), '自动跟随系统语言');
  for (const width of [390,1280]) for (const mode of ['light','dark']) {
    await page.setViewportSize({width,height:844});
    await page.evaluate(mode => (window as any).fixture.setTheme(mode), mode);
    const box = await englishCreate.boundingBox();
    assert.ok(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= 844);
    assert.equal(await englishCreate.getByRole('textbox', {name:'Goal objective'}).inputValue(), '自动跟随系统语言');
    await page.screenshot({path:`${output}/en-US-${mode}-dialog-${width}.png`});
  }
  await englishCreate.getByRole('button', { name: 'Cancel', exact: true }).click();
  for (const width of [390,1280]) {
    await page.setViewportSize({width,height:844});
    await englishAdd.click();
    await page.getByRole('menuitem',{name:'Set a goal',exact:true}).waitFor();
    assert.equal(await page.getByRole('menuitem',{name:'Attach files',exact:true}).count(),1);
    assert.equal(await page.getByRole('menuitem',{name:'Connectors',exact:true}).count(),1);
    await page.screenshot({path:`${output}/en-US-menu-${width}.png`});
    await page.keyboard.press('Escape'); await page.getByRole('menu').waitFor({state:'hidden'});
  }
  assert.deepEqual(errors, []);
  // Real mouse/keyboard and coarse-pointer pages share the same component.
  let adaptiveCases = 0;
  for (const touch of [false, true]) {
    const adaptive = await browser.newPage({ viewport: {width:touch?390:1280,height:844},hasTouch:touch,isMobile:touch,locale:'zh-CN' });
    adaptive.setDefaultTimeout(10000);
    const adaptiveErrors: string[] = [];
    adaptive.on('pageerror', (error: Error) => adaptiveErrors.push(error.message));
    await adaptive.addInitScript('window.__name=value=>value');
    await adaptive.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`);
    await adaptive.locator('.thread-goal__summary').waitFor();
    await adaptive.evaluate(touch => { document.documentElement.dataset.uiDensity=touch?'touch':'compact'; (window as any).fixture.setExtras(true); },touch);
    for (const capacity of touch ? [320,390] : [430,800]) for (const palette of ['canvas','lavender']) for (const mode of ['light','dark']) for (const language of ['zh-CN','en-US']) {
      await adaptive.setViewportSize({width:touch?capacity:1280,height:844});
      await adaptive.evaluate(({capacity,palette,mode,language}) => {
        const f=(window as any).fixture; f.setCapacity(capacity); f.setPalette(mode,palette); return f.setLocale(language);
      },{capacity,palette,mode,language});
      await adaptive.locator('.opencraft-composer-editor').click();
      await adaptive.mouse.move(4,4);
      const goalSummary=adaptive.locator('.thread-goal__summary');
      await adaptive.locator('.thread-goal__label').filter({hasText:language==='zh-CN'?'正在推进目标':'Pursuing goal'}).waitFor();
      const target=adaptive.locator('.thread-goal__target');
      const motion=await target.evaluate(el=>({count:el.getAnimations().length,duration:el.getAnimations()[0]?.effect?.getTiming().duration,mask:getComputedStyle(el).maskPosition}));
      assert.equal(motion.count,1,'an active Goal must visibly animate in the Composer');
      assert.equal(motion.duration,3200,'reuse the quiet sidebar cadence');
      await adaptive.waitForFunction(previous=>getComputedStyle(document.querySelector('.thread-goal__target')!).maskPosition!==previous,motion.mask);
      const rail=adaptive.locator('.opencraft-composer-attached-rail');
      const geometry=await rail.evaluate((el:HTMLElement) => {
        const row=el.querySelector('.thread-goal')!; const r=row.getBoundingClientRect(); const editor=el.nextElementSibling!.getBoundingClientRect();
        return {children:[...el.children].map(n=>n.className),height:r.height,width:r.width,bottom:el.getBoundingClientRect().bottom,editorTop:editor.top,shellRadius:parseFloat(getComputedStyle(el.nextElementSibling!).borderTopLeftRadius),overflow:document.documentElement.scrollWidth>innerWidth,buttonRects:[...row.querySelectorAll('button')].filter(n=>getComputedStyle(n).display!=='none').map(n=>{const b=n.getBoundingClientRect();return {x:b.x,right:b.right,width:b.width,height:b.height}})};
      });
      assert.deepEqual(geometry.children,['opencraft-composer-queue-tray','thread-goal']);
      assert.equal(await adaptive.locator('.thread-live-changes').evaluate(el => el.parentElement?.classList.contains('opencraft-composer-stack')),true);
      assert.equal(geometry.bottom-geometry.editorTop,geometry.shellRadius,"rail meets the current symmetric editor contour");
      assert.equal(geometry.overflow,false);
      const railBox=await rail.boundingBox();assert.ok(railBox);
      for (const b of geometry.buttonRects) {
        assert.ok(b.x>=railBox!.x && b.right<=railBox!.x+railBox!.width,JSON.stringify({touch,capacity,b,railBox}));
        if(touch) assert.ok(b.width>=44 && b.height>=44,JSON.stringify(b));
      }
      assert.equal(await adaptive.locator('.thread-goal__edit').isVisible(),capacity>540);
      assert.equal(await adaptive.locator('.thread-goal__preview').isVisible(),capacity>540);
      assert.ok(geometry.height <= (capacity>540?40:52),JSON.stringify(geometry));
      const resting=await goalSummary.evaluate(el=>({background:getComputedStyle(el).backgroundColor,shadow:getComputedStyle(el).boxShadow}));
      assert.equal(resting.background,'rgba(0, 0, 0, 0)');assert.equal(resting.shadow,'none');
      if(language==='zh-CN') await adaptive.screenshot({path:`${output}/rail-${touch?'touch':'mouse'}-${capacity}-${palette}-${mode}.png`});
      await goalSummary.click();
      const detail=adaptive.locator('.thread-goal__detail');await detail.waitFor();
      const box=await detail.boundingBox();const viewport=adaptive.viewportSize()!;
      assert.ok(box && box.x>=0 && box.y>=0 && box.x+box.width<=viewport.width && box.y+box.height<=viewport.height,JSON.stringify(box));
      assert.match(await detail.innerText(),/完成移动端目标体验/);
      // Outside press returns to the unchanged composer; Escape restores trigger.
      await adaptive.mouse.click(4,4);await detail.waitFor({state:'hidden'});
      await goalSummary.click();await detail.waitFor();await adaptive.keyboard.press('Escape');await detail.waitFor({state:'hidden'});
      await adaptive.waitForFunction(()=>document.activeElement?.classList.contains('thread-goal__summary'));
      adaptiveCases++;
    }
    // Rendered pixels change, while glyph and text geometry stay fixed.
    const target=adaptive.locator('.thread-goal__target');
    const phases=[];const images=[];
    for(const phase of [0,0.25]) {
      phases.push(await target.evaluate(async(el,phase)=>{
        const a=el.getAnimations()[0]!;a.pause();a.currentTime=Number(a.effect!.getTiming().duration)*phase;
        await new Promise(requestAnimationFrame);
        const b=el.getBoundingClientRect();return {transform:getComputedStyle(el).transform,box:{x:b.x,y:b.y,width:b.width,height:b.height}};
      },phase));
      images.push(await target.screenshot({path:`${output}/goal-motion-${touch?'touch':'mouse'}-${phase}.png`}));
    }
    assert.deepEqual(phases[0],phases[1]);assert.equal(phases[0].transform,'none');
    assert.ok(!images[0].equals(images[1]),'Goal shimmer must alter actual pixels');
    await target.evaluate(el=>el.getAnimations()[0]!.play());
    for(const attribute of ['inert','aria-hidden']) {
      await adaptive.locator('.thread-goal').evaluate((el,attribute)=>el.setAttribute(attribute,attribute==='inert'?'':'true'),attribute);
      assert.equal(await target.evaluate(el=>getComputedStyle(el).animationPlayState),'paused');
      await adaptive.locator('.thread-goal').evaluate((el,attribute)=>el.removeAttribute(attribute),attribute);
      assert.equal(await target.evaluate(el=>getComputedStyle(el).animationPlayState),'running');
    }
    await adaptive.emulateMedia({reducedMotion:'reduce'});
    assert.equal(await target.evaluate(el=>el.getAnimations().length),0);
    assert.equal(await target.evaluate(el=>getComputedStyle(el).maskImage),'none');
    await adaptive.emulateMedia({reducedMotion:'no-preference'});
    assert.equal(await target.evaluate(el=>el.getAnimations().length),1);
    // All states remain readable and manageable at the narrowest capacity.
    await adaptive.evaluate(()=>(window as any).fixture.setLocale('en-US'));
    await adaptive.evaluate(()=>(window as any).fixture.setCapacity(320));
    const statuses={active:'Pursuing goal',paused:'Goal paused',blocked:'Goal needs help',usageLimited:'Goal usage limit reached',budgetLimited:'Goal budget limit reached'};
    for(const [status,label] of Object.entries(statuses)) {
      await adaptive.evaluate(status=>(window as any).fixture.setGoal({status,objective:'A very long objective / 保留原文 '.repeat(80),tokenBudget:1234567,tokensUsed:123456,timeUsedSeconds:1139760}),status);
      await adaptive.locator('.thread-goal__label').filter({hasText:label}).waitFor();
      assert.equal(await target.evaluate(el=>el.getAnimations().length),status==='active'?1:0,'only pursuing Goals animate');
      await adaptive.locator('.thread-goal__summary').click();
      const detail=adaptive.locator('.thread-goal__detail');await detail.waitFor();
      assert.ok(await detail.evaluate(el=>el.scrollHeight>=el.clientHeight));
      await adaptive.keyboard.press('Escape');await detail.waitFor({state:'hidden'});
    }
    // Read-only keeps disclosure while exposing no mutation controls.
    await adaptive.evaluate(()=>(window as any).fixture.readonly(true));
    assert.equal(await adaptive.locator('.thread-goal__actions').count(),0);
    await adaptive.locator('.thread-goal__summary').click();await adaptive.locator('.thread-goal__detail').waitFor();
    await adaptive.keyboard.press('Escape');await adaptive.locator('.thread-goal__detail').waitFor({state:'hidden'});
    await adaptive.evaluate(()=>(window as any).fixture.readonly(false));
    // A size change must retain both real editors and restore a visible opener.
    const composerNode=await adaptive.locator('.opencraft-composer-editor').elementHandle();
    await adaptive.getByRole('button',{name:'Goal actions',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'Edit',exact:true}).click();
    const editorDialog=adaptive.getByRole('dialog',{name:'Edit goal',exact:true});await editorDialog.waitFor();
    const goalInput=editorDialog.getByRole('textbox',{name:'Goal objective'});await goalInput.fill('Keep the unsaved draft / 保留草稿');
    const inputNode=await goalInput.elementHandle();
    await adaptive.setViewportSize({width:touch?390:1280,height:420});
    await adaptive.evaluate(()=>(window as any).fixture.setCapacity(800));
    assert.equal(await inputNode?.evaluate(el=>el.isConnected && el===document.activeElement),true);
    assert.equal(await goalInput.inputValue(),'Keep the unsaved draft / 保留草稿');
    assert.equal(await composerNode?.evaluate(el=>el.isConnected),true);
    const shortBox=await editorDialog.boundingBox();assert.ok(shortBox && shortBox.y>=0 && shortBox.y+shortBox.height<=420);
    await editorDialog.getByRole('button',{name:'Cancel',exact:true}).click();await editorDialog.waitFor({state:'hidden'});
    await adaptive.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Goal actions');
    // Touch opening does not draw a keyboard ring; Tab restores neutral focus.
    await adaptive.setViewportSize({width:touch?390:1280,height:844});
    if(touch) {
      await adaptive.locator('.thread-goal__summary').tap();await adaptive.locator('.thread-goal__detail').waitFor();
      const close=adaptive.locator('.thread-goal__detail').getByRole('button',{name:'Close',exact:true});
      assert.equal(await close.evaluate(el=>getComputedStyle(el).outlineStyle),'none');
      await close.tap();await adaptive.locator('.thread-goal__detail').waitFor({state:'hidden'});
    }
    await adaptive.locator('.thread-goal__summary').focus();await adaptive.keyboard.press('Tab');
    const focus=await adaptive.evaluate(()=>{const el=document.activeElement!;return {tag:el.tagName,outline:getComputedStyle(el).outlineStyle,color:getComputedStyle(el).outlineColor}});
    assert.equal(focus.tag,'BUTTON');assert.notEqual(focus.outline,'none');
    await adaptive.emulateMedia({reducedMotion:'reduce',forcedColors:'active'});
    await adaptive.locator('.thread-goal__summary').click();await adaptive.locator('.thread-goal__detail').waitFor();
    assert.notEqual(await adaptive.locator('.thread-goal__detail').evaluate(el=>getComputedStyle(el).borderTopStyle),'none');
    await adaptive.keyboard.press('Escape');await adaptive.locator('.thread-goal__detail').waitFor({state:'hidden'});
    await adaptive.emulateMedia({reducedMotion:'no-preference',forcedColors:'none'});
    // Remove is available through the real menu and does not clear the composer.
    await adaptive.locator('.opencraft-composer-editor').fill('keep this ordinary input');
    await adaptive.getByRole('button',{name:'Goal actions',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'Remove',exact:true}).click();
    await adaptive.locator('.thread-goal').waitFor({state:'hidden'});
    assert.equal(await adaptive.locator('.opencraft-composer-editor').innerText(),'keep this ordinary input');
    // Completion is a terminal presentation boundary, never an implicit clear.
    const composerBefore = await adaptive.locator('.opencraft-composer-editor').elementHandle();
    const countsBefore = await adaptive.evaluate(() => { const f=(window as any).fixture; return {set:f.setCalls(),clear:f.clearCalls()}; });
    for (const mode of ['light','dark']) {
      await adaptive.evaluate(mode => { const f=(window as any).fixture; f.setPalette(mode,'canvas'); f.setGoal({status:'active',objective:'Keep the completed result',tokenBudget:12345,tokensUsed:1234}); }, mode);
      await adaptive.locator('.thread-goal__summary').click();
      await adaptive.locator('.thread-goal__detail').waitFor();
      await adaptive.evaluate(() => (window as any).fixture.setGoal({status:'complete',objective:'Keep the completed result',tokenBudget:12345,tokensUsed:1234}));
      await adaptive.locator('.thread-goal').waitFor({state:'hidden'});
      await adaptive.locator('.thread-goal__detail').waitFor({state:'hidden'});
      assert.equal(await composerBefore?.evaluate(el=>el.isConnected),true);
      assert.equal(await adaptive.locator('.opencraft-composer-editor').innerText(),'keep this ordinary input');
      assert.deepEqual(await adaptive.evaluate(() => { const f=(window as any).fixture; return {set:f.setCalls(),clear:f.clearCalls()}; }),countsBefore);
      // Read-only completion keeps review accessible, with no write controls.
      await adaptive.evaluate(()=>(window as any).fixture.readonly(true));
      await adaptive.getByRole('button',{name:'Add',exact:true}).click();
      assert.equal(await adaptive.getByRole('menuitem',{name:'Set a goal',exact:true}).count(),0);
      await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).click();
      let completedDialog=adaptive.getByRole('dialog',{name:'View completed goal',exact:true});
      await completedDialog.waitFor();
      await completedDialog.getByText('Keep the completed result',{exact:true}).waitFor();
      await completedDialog.getByText('Used 1,234 / 12,345',{exact:true}).waitFor();
      assert.equal(await completedDialog.getByRole('button',{name:'Remove',exact:true}).count(),0);
      await adaptive.screenshot({path:`${output}/complete-review-${touch?'touch':'mouse'}-${mode}.png`});
      await adaptive.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));
      await adaptive.getByRole('dialog',{name:'查看已完成目标',exact:true}).getByText('目标已完成',{exact:true}).waitFor();
      await adaptive.evaluate(()=>(window as any).fixture.setLocale('en-US'));
      await adaptive.keyboard.press('Escape');await completedDialog.waitFor({state:'hidden'});
      await adaptive.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Add');
      await adaptive.evaluate(()=>(window as any).fixture.readonly(false));
      await adaptive.getByRole('button',{name:'Add',exact:true}).click();
      await adaptive.getByRole('menuitem',{name:'Set a goal',exact:true}).click();
      const nextDialog=adaptive.getByRole('dialog',{name:'Set a goal',exact:true});await nextDialog.waitFor();
      assert.equal(await nextDialog.getByRole('textbox').inputValue(),'');
      await nextDialog.getByRole('textbox').fill('Next explicit goal');
      await nextDialog.getByRole('button',{name:'Cancel',exact:true}).click();await nextDialog.waitFor({state:'hidden'});
      assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),'complete');
      await adaptive.screenshot({path:`${output}/complete-retired-${touch?'touch':'mouse'}-${mode}.png`});
    }
    // A completed native goal remains editable and resumes the same accounting cycle.
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).click();
    const review=adaptive.getByRole('dialog',{name:'View completed goal',exact:true});
    const retainedUsage=await adaptive.evaluate(()=>(window as any).fixture.goalUsage());
    await review.getByRole('button',{name:'Edit',exact:true}).click();
    const resumedEdit=adaptive.locator('.thread-goal-dialog');
    assert.equal(await resumedEdit.getByRole('textbox').inputValue(),'Keep the completed result');
    await resumedEdit.getByRole('textbox').fill('Discard this change');
    await resumedEdit.getByRole('button',{name:'Revert',exact:true}).click();
    assert.equal(await resumedEdit.getByRole('textbox').inputValue(),'Keep the completed result');
    await resumedEdit.getByRole('textbox').fill('Finish the remaining work');
    const editedInput=await resumedEdit.getByRole('textbox').elementHandle();
    await adaptive.evaluate(()=>(window as any).fixture.setLocale('zh-CN'));
    await adaptive.getByRole('button',{name:'保存并继续',exact:true}).waitFor();
    assert.equal(await editedInput?.evaluate(el=>el.isConnected),true);
    assert.equal(await resumedEdit.getByRole('textbox').inputValue(),'Finish the remaining work');
    await adaptive.evaluate(()=>(window as any).fixture.setLocale('en-US'));
    await adaptive.evaluate(()=>(window as any).fixture.failWrite(true));
    await resumedEdit.getByRole('button',{name:'Save and resume',exact:true}).click();
    await resumedEdit.getByRole('alert').waitFor();
    assert.equal(await resumedEdit.getByRole('textbox').inputValue(),'Finish the remaining work');
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),'complete');
    await adaptive.evaluate(()=>(window as any).fixture.failWrite(false));
    await adaptive.screenshot({path:`${output}/completed-edit-${touch?'touch':'mouse'}.png`});
    await resumedEdit.getByRole('button',{name:'Save and resume',exact:true}).click();
    await resumedEdit.waitFor({state:'hidden'});
    await adaptive.locator('.thread-goal__label').filter({hasText:'Pursuing goal'}).waitFor();
    assert.deepEqual(await adaptive.evaluate(()=>(window as any).fixture.lastChange()),{objective:'Finish the remaining work',status:'active'});
    assert.deepEqual(await adaptive.evaluate(()=>(window as any).fixture.goalUsage()),retainedUsage);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.clearCalls()),countsBefore.clear);
    assert.equal(await composerBefore?.evaluate(el=>el.isConnected),true);
    assert.equal(await adaptive.locator('.opencraft-composer-editor').innerText(),'keep this ordinary input');
    await adaptive.evaluate(()=>(window as any).fixture.setGoal({status:'complete',objective:'Keep the completed result'}));
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).click();
    await adaptive.getByRole('dialog',{name:'View completed goal',exact:true}).getByRole('button',{name:'Resume',exact:true}).click();
    await adaptive.getByRole('dialog').waitFor({state:'hidden'});
    assert.deepEqual(await adaptive.evaluate(()=>(window as any).fixture.lastChange()),{status:'active'});
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.clearCalls()),countsBefore.clear);
    // Completion during editing preserves the draft and requires an explicit resume.

    await adaptive.evaluate(()=>(window as any).fixture.setGoal({status:'active'}));
    await adaptive.getByRole('button',{name:'Goal actions',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'Edit',exact:true}).click();
    const oldEdit=adaptive.getByRole('dialog',{name:'Edit goal',exact:true});await oldEdit.waitFor();
    await oldEdit.getByRole('textbox').fill('Keep my unsaved edit');
    await adaptive.evaluate(()=>(window as any).fixture.setGoal({status:'complete',objective:'Keep the completed result'}));
    assert.equal(await oldEdit.getByRole('textbox').inputValue(),'Keep my unsaved edit');
    assert.equal(await oldEdit.getByRole('button',{name:'Save and resume',exact:true}).isEnabled(),true);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),'complete');
    await oldEdit.getByRole('button',{name:'Cancel',exact:true}).click();await oldEdit.waitFor({state:'hidden'});
    // Failed explicit replacement retains both the completed record and new draft.
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'Set a goal',exact:true}).click();
    const next=adaptive.getByRole('dialog',{name:'Set a goal',exact:true});await next.waitFor();
    await next.getByRole('textbox').fill('Next explicit goal');
    await adaptive.evaluate(()=>(window as any).fixture.failWrite(true));
    await next.getByRole('button',{name:'Save',exact:true}).click();
    await next.getByRole('alert').waitFor();
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),undefined);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.completedObjective()),'Keep the completed result');
    assert.equal(await next.getByRole('textbox').inputValue(),'Next explicit goal');
    await adaptive.evaluate(()=>(window as any).fixture.failWrite(false));
    await next.getByRole('button',{name:'Save',exact:true}).click();await next.waitFor({state:'hidden'});
    await adaptive.locator('.thread-goal__label').filter({hasText:'Pursuing goal'}).waitFor();
    assert.equal(await adaptive.locator('.thread-goal__detail').count(),0,'a completed disclosure cannot reopen for the next goal');
    assert.deepEqual(await adaptive.evaluate(()=>(window as any).fixture.lastChange()),{objective:'Next explicit goal',status:'active',tokenBudget:null});
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.clearCalls()),countsBefore.clear+1);
    await adaptive.locator('.thread-goal__time').filter({hasText:/^[0-9]+s$/}).waitFor();
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.goalUsage().tokensUsed),0);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.goalUsage().timeUsedSeconds),0);
    // Visiting another Thread and returning does not resurrect the completed rail.
    await adaptive.evaluate(()=>(window as any).fixture.setGoal({status:'complete'}));
    await adaptive.evaluate(()=>(window as any).fixture.switchThread('two'));
    await adaptive.waitForFunction(()=>{const f=(window as any).fixture;return f.threadId()==='two' && f.goalPhase()==='ready'});
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).waitFor();
    await adaptive.keyboard.press('Escape');await adaptive.getByRole('menu').waitFor({state:'hidden'});
    await adaptive.evaluate(()=>(window as any).fixture.switchThread('one'));
    await adaptive.waitForFunction(()=>{const f=(window as any).fixture;return f.threadId()==='one' && f.goalPhase()==='ready'});
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).click();
    const last=adaptive.getByRole('dialog',{name:'View completed goal',exact:true});await last.waitFor();
    await last.locator('.modal-surface__close').click();await last.waitFor({state:'hidden'});
    const ordinary=adaptive.locator('.opencraft-composer-editor');
    await ordinary.fill('An ordinary follow-up');
    if (touch) await adaptive.getByRole('button',{name:'Send message',exact:true}).click();
    else await ordinary.press('Enter');
    await adaptive.waitForFunction(()=>(window as any).fixture.submitted()===1);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),'complete');
    assert.equal(await adaptive.locator('.thread-goal').count(),0);
    await adaptive.getByRole('button',{name:'Add',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'View completed goal',exact:true}).click();
    await adaptive.getByRole('dialog',{name:'View completed goal',exact:true}).getByRole('button',{name:'Remove',exact:true}).click();
    await adaptive.getByRole('dialog').waitFor({state:'hidden'});
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.clearCalls()),countsBefore.clear+2);
    assert.equal(await adaptive.evaluate(()=>(window as any).fixture.status()),undefined);
    await adaptive.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}/?completed=1`);
    await adaptive.locator('.opencraft-composer-editor').waitFor();
    await adaptive.getByRole('button',{name:'添加',exact:true}).click();
    await adaptive.getByRole('menuitem',{name:'查看已完成目标',exact:true}).waitFor();
    assert.equal(await adaptive.locator('.thread-goal').count(),0,'hydrating an already completed Goal allocates no rail');
    assert.deepEqual(await adaptive.evaluate(()=>{const f=(window as any).fixture;return {set:f.setCalls(),clear:f.clearCalls()}}),{set:0,clear:0});
    console.log(`completion lifecycle passed: ${touch ? "touch" : "mouse"}`);
    assert.deepEqual(adaptiveErrors,[]);await adaptive.close();
  }
  const dsh = await browser.newPage({viewport:{width:390,height:844},locale:'zh-CN',isMobile:true,hasTouch:true});
  dsh.setDefaultTimeout(10000); dsh.setDefaultNavigationTimeout(60000);
  await dsh.addInitScript("window.__name = value => value");
  await dsh.goto(`http://127.0.0.1:${(vite.httpServer!.address() as {port:number}).port}`);
  await dsh.locator('.thread-goal').waitFor();
  await dsh.evaluate(() => {const f=(window as any).fixture; f.accounting(false);f.setGoal({status:'active',execution:{activation:'disarmed'}});});
  await dsh.getByRole('button',{name:'继续',exact:true}).waitFor();
  assert.equal(await dsh.locator('.thread-goal__time').count(),0,'DSH does not fabricate elapsed time');
  assert.equal(await dsh.locator('.thread-goal').getAttribute('data-goal-status'),'paused');
  await dsh.getByRole('button',{name:'继续',exact:true}).click();
  assert.equal(await dsh.evaluate(() => (window as any).fixture.lastChange().status),'active');
  await dsh.close();
  // Exercise the real Goal surface and its Composer render prop with browser time.
  const clockPage = await browser.newPage({ viewport: { width: 1280, height: 844 }, locale: "en-US" });
  const clockErrors: string[] = [];
  clockPage.on("pageerror", (error: Error) => clockErrors.push(error.message));
  await clockPage.addInitScript("window.__name = value => value");
  await clockPage.clock.install();
  await clockPage.goto(`http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`);
  await clockPage.locator('.thread-goal__time').waitFor();
  await clockPage.clock.pauseAt(new Date(await clockPage.evaluate(() => Date.now()) + 100));
  const setClockGoal = async (timeUsedSeconds: number, status = "active") => {
    await clockPage.evaluate(({timeUsedSeconds,status}) => (window as any).fixture.setGoal({timeUsedSeconds,status,updatedAt:Date.now()/1000}),{timeUsedSeconds,status});
    await clockPage.clock.runFor(50);
  };
  const renderCount = () => clockPage.evaluate(() => (window as any).fixture.composerRenders());
  const clockLabel = () => clockPage.locator('.thread-goal__time').getAttribute('title');
  await setClockGoal(120);
  const steadyCount = await renderCount(), steadyLabel = await clockLabel();
  await clockPage.clock.runFor(10000);
  assert.equal(await renderCount(),steadyCount,'unchanged minute must not rerender the Composer');
  assert.equal(await clockLabel(),steadyLabel);
  await clockPage.clock.fastForward(60000);
  assert.notEqual(await clockLabel(),steadyLabel,'a later minute must refresh after a clock jump');
  await setClockGoal(59);
  const secondLabel = await clockLabel();
  await clockPage.clock.runFor(1100);
  assert.notEqual(await clockLabel(),secondLabel,'59 seconds must advance into the first minute');
  await setClockGoal(12);
  const shortLabel = await clockLabel();
  await clockPage.clock.runFor(1100);
  assert.notEqual(await clockLabel(),shortLabel,'first-minute seconds retain their existing precision');
  await setClockGoal(59,"paused");
  const pausedCount = await renderCount(), pausedLabel = await clockLabel();
  await clockPage.clock.runFor(5000);
  assert.equal(await renderCount(),pausedCount); assert.equal(await clockLabel(),pausedLabel);
  await setClockGoal(7200);
  const accountingLabel = await clockLabel();
  await setClockGoal(7260);
  assert.notEqual(await clockLabel(),accountingLabel,'server accounting updates immediately replace the timer baseline');
  await clockPage.evaluate(() => (window as any).fixture.accounting(false));
  await clockPage.clock.runFor(50);
  assert.equal(await clockPage.locator('.thread-goal__time').count(),0);
  const noAccountingCount = await renderCount();
  await clockPage.clock.runFor(5000);
  assert.equal(await renderCount(),noAccountingCount,'no accounting capability must leave no clock updates');
  assert.deepEqual(clockErrors,[]);
  await clockPage.close();
  console.log("goal clock precision, accounting and Composer render isolation passed");
  assert.equal(adaptiveCases,32);
  console.log(JSON.stringify({ output, passed: true, adaptiveCases, evidence: ["DSH disarmed Resume and absent usage metrics", "real automatic system locale and persisted override; live dialog language switching retains input/DOM/focus; English fallback and locale numbers; all Goal status messages", "existing goal light/dark", "touch Add menu, cancel and draft preservation", "keyboard create and confirmed goal", "read-only and missing Thread hide creation", "Thread switch closes draft without remounting Composer", "real new Draft light/dark at 390/1280: cancel, readonly, offline", "new Goal without ordinary submit; busy and failed write retry keep Thread and input"] }));
} finally {
  await browser?.close();
  await vite.close();
}
