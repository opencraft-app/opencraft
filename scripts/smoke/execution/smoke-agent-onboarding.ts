import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createServer } from "vite";
const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const output = process.env.OPENCRAFT_ONBOARDING_OUTPUT ?? "/tmp/opencraft-agent-onboarding";
const vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error",
  resolve: { dedupe: ["react", "react-dom"] }, cacheDir: "node_modules/.vite-agent-onboarding", esbuild: { jsx: "automatic" },
  server: { host: "127.0.0.1", port: 0 },
  plugins: [{ name: "onboarding-fixture", configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url !== "/" && !req.url?.startsWith("/?")) return next();
      res.setHeader("content-type", "text/html");
      res.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/tests/fixtures/agent-onboarding.tsx"></script>');
    });
  } }],
});
let browser: any;
try {
  await mkdir(output, { recursive: true }); await vite.listen();
  browser = await chromium.launch({ headless: true, ...(process.env.OPENCRAFT_CHROMIUM_EXECUTABLE ? { executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE } : {}) });
  const base = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  page.setDefaultTimeout(15_000);
  const errors: string[] = []; page.on("pageerror", (error: Error) => { errors.push(error.message); console.error("Onboarding browser error:", error.message); });
  const waitCall = (key: string, count = 1) => page.waitForFunction(({ key, count }) => (window as any).onboardingFixture?.calls.filter((call: string) => call === key).length >= count, { key, count });
  const resolve = (key: string, models: { id: string; name: string }[]) => page.evaluate(({ key, models }) => (window as any).onboardingFixture.resolve(key, { models }), { key, models });
  const codex = [{ id: "codex:one", name: "Codex One" }, { id: "codex:two", name: "Codex Two" },
    ...Array.from({ length: 24 }, (_, i) => ({ id: `codex:extra-${i}`, name: `Extra model ${i}` }))];
  const cursor = [{ id: "cursor:one", name: "Cursor One" }];
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await page.goto(base); await waitCall("host-a:codex");
  assert.equal(await next.isDisabled(), true);
  await resolve("host-a:codex", codex);
  await page.getByRole("button", { name: "Codex One", exact: true }).waitFor();
  assert.equal(await next.isEnabled(), true, "a ready agent exposes its models without a hidden row click");
  assert.equal(await page.getByRole("button", { name: "Codex One", exact: true }).getAttribute("aria-pressed"), "true");
  await page.getByRole("button", { name: "Codex Two", exact: true }).click();
  await next.click(); assert.match(await page.locator(".agent-onboard__selection").innerText(), /Codex Two/);
  // Closing the currently selected Agent must not silently choose another ready Agent.
  await page.evaluate(() => (window as any).onboardingFixture.setDisabledAgents(["codex"]));
  await page.getByRole("button", { name: "Continue", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Continue", exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole("button", { name: "Start chatting", exact: true }).count(), 0);
  assert.equal(await page.locator('li[data-agent="cursor"]').getByRole("button", { name: "Cursor One", exact: true }).count(), 0);
  await page.evaluate(() => (window as any).onboardingFixture.setDisabledAgents([]));
  await page.getByRole("button", { name: "Start chatting", exact: true }).waitFor();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  const chooseCursor = page.locator('li[data-agent="cursor"]').getByRole("button", { name: "Choose models" });
  await chooseCursor.focus(); await page.keyboard.press("Enter"); await waitCall("host-a:cursor");
  assert.equal(await next.isDisabled(), true, "switching agents cannot keep the previous model");
  await page.locator('li[data-agent="codex"]').getByRole("button", { name: "Choose models" }).click();
  await resolve("host-a:cursor", cursor);
  assert.equal(await page.getByRole("button", { name: "Codex Two", exact: true }).getAttribute("aria-pressed"), "true", "a late result cannot overwrite a newer choice");
  await chooseCursor.click(); await page.getByRole("button", { name: "Cursor One", exact: true }).waitFor();
  await next.click(); await page.getByRole("button", { name: "Start chatting" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).onboardingFixture.finished), ["cursor:one"]);

  // Failure, empty response and retry must all leave a working recovery action.
  await page.goto(base); await waitCall("host-a:codex");
  await page.evaluate(() => (window as any).onboardingFixture.fail("host-a:codex"));
  await page.getByRole("button", { name: "Retry", exact: true }).click(); await waitCall("host-a:codex", 2);
  await resolve("host-a:codex", []);
  await page.getByRole("button", { name: "Use the default model" }).click();
  await next.click(); await page.getByRole("button", { name: "Start chatting" }).click();
  assert.deepEqual(await page.evaluate(() => (window as any).onboardingFixture.finished), ["codex:current"]);

  // Changing hosts retires both the old model selection and any pending result.
  await page.goto(base); await waitCall("host-a:codex");
  await page.evaluate(() => (window as any).onboardingFixture.setHostId("host-b")); await waitCall("host-b:codex");
  await resolve("host-a:codex", codex);
  assert.equal(await next.isDisabled(), true);
  await resolve("host-b:codex", [{ id: "codex:host-b", name: "Host B model" }]);
  await page.getByRole("button", { name: "Host B model" }).waitFor();
  await page.evaluate(() => (window as any).onboardingFixture.refresh(false));
  await page.getByRole("button", { name: "Sign in", exact: true }).first().waitFor();
  assert.equal(await next.isDisabled(), true, "signed-out agents cannot finish with a stale choice");
  assert.deepEqual(errors, []);
  await page.close();

  // Check the rendered composition with genuine touch input, themes and a short viewport.
  for (const touch of [false, true]) {
    const context = await browser.newContext({ viewport: { width: touch ? 390 : 1100, height: 850 }, hasTouch: touch, isMobile: touch, reducedMotion: "reduce" });
    const p = await context.newPage(); p.on("pageerror", (error: Error) => console.error("Onboarding locale browser error:", error.message)); p.setDefaultTimeout(15_000); await p.goto(`${base}/?locale=zh-CN`);
    try { await p.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex")); } catch (error) { console.error("Onboarding state", await p.locator("body").innerText()); throw error; }
    await p.evaluate(models => (window as any).onboardingFixture.resolve("host-a:codex", { models }), codex);
    await p.getByRole("button", { name: "Codex Two", exact: true }).waitFor();
    for (const theme of ["light", "dark", "lavender"]) {
      await p.evaluate(theme => {
        const f = (window as any).onboardingFixture;
        f.setThemePreference(theme === "dark" ? "dark" : "light");
        if (theme === "lavender") f.setAppearanceThemeId("opencraft.core.lavender");
      }, theme);
      const choice = p.getByRole("button", { name: "Codex Two", exact: true });
      if (touch) await choice.tap(); else { await choice.focus(); await p.keyboard.press("Space"); }
      assert.equal(await choice.getAttribute("aria-pressed"), "true");
      const next = p.getByRole("button", { name: "继续", exact: true });
      await next.scrollIntoViewIfNeeded();
      assert.equal(await p.locator(".agent-onboard__models ul").evaluate(el => el.scrollHeight > el.clientHeight), true, "long model lists scroll within the page");
      assert.equal(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.equal(await p.evaluate(() => getComputedStyle(document.querySelector(".agent-onboard-gate")!).backgroundColor
        === getComputedStyle(document.querySelector(".agent-onboard")!).backgroundColor), true, "the setup canvas follows the themed surface");
      await p.screenshot({ path: `${output}/${touch ? "touch" : "desktop"}-${theme}.png` });
      if (touch) await next.tap(); else await next.click();
      assert.match(await p.locator(".agent-onboard__selection").innerText(), /Codex Two/);
      await p.getByRole("button", { name: "返回", exact: true }).click();
    }
    await context.close();
  }
  // During asynchronous Start, every exit button stays disabled until ownership settles.
  const finishingPage = await browser.newPage();
  await finishingPage.goto(base);
  await finishingPage.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex"));
  await finishingPage.evaluate(() => {
    const stage = document.getElementById("root")!;
    stage.classList.add("workbench-route-stage");
    Object.assign(stage.style, { position: "fixed", inset: "46px 0 0 240px", width: "auto", height: "auto" });
    const fixture = (window as any).onboardingFixture;
    fixture.resolve("host-a:codex", { models: [{ id: "codex:one", name: "Codex One" }] });
    fixture.setPresentation("sheet"); fixture.holdFinish();
  });
  await finishingPage.getByRole("button", { name: "Back to model settings", exact: true }).waitFor();
  const sheetBounds = await finishingPage.locator(".agent-onboard-gate").boundingBox();
  const stageBounds = await finishingPage.locator(".workbench-route-stage").boundingBox();
  assert.deepEqual(sheetBounds, stageBounds, "settings setup covers its route stage and leaves shell navigation outside it");
  await finishingPage.getByRole("button", { name: "Continue", exact: true }).click();
  await finishingPage.getByRole("button", { name: "Start chatting", exact: true }).click();
  assert.equal(await finishingPage.getByRole("button", { name: "Back to model settings", exact: true }).isDisabled(), true);
  assert.equal(await finishingPage.getByRole("button", { name: "Back", exact: true }).isDisabled(), true);
  assert.equal(await finishingPage.getByRole("button", { name: "Start chatting", exact: true }).isDisabled(), true);
  await finishingPage.evaluate(() => (window as any).onboardingFixture.releaseFinish());
  await finishingPage.waitForFunction(() => (window as any).onboardingFixture.finished.includes("codex:one"));
  await finishingPage.close();
  // Actual import UI, with only the agent boundary simulated.
  const historyPage = await browser.newPage({ viewport: { width: 1100, height: 850 } });
  historyPage.on("pageerror", (error: Error) => errors.push(error.message));
  await historyPage.goto(`${base}/?history=1`);
  await historyPage.waitForFunction(() => (window as any).onboardingFixture?.calls.includes("host-a:codex"));
  await historyPage.evaluate(() => (window as any).onboardingFixture.resolve("host-a:codex", { models: [{ id: "codex:one", name: "Codex One" }] }));
  await historyPage.getByRole("button", { name: "Continue", exact: true }).click();
  await historyPage.locator('.agent-history-source[data-agent="codex"]').getByRole("button").first().click();
  await historyPage.getByRole("button", {name:/^project/}).click();
  const choice = historyPage.getByRole("checkbox", { name: /Continue my local project/ });
  await choice.waitFor(); assert.equal(await historyPage.getByRole("button", { name: "Import selected (0)", exact: true }).isDisabled(), true);
  await choice.focus(); await historyPage.keyboard.press("Space"); assert.equal(await choice.getAttribute("aria-checked"), "true");
  await historyPage.screenshot({ path: `${output}/history-selected.png` });
  await historyPage.getByRole("button", { name: "Import selected (1)", exact: true }).click();
  assert.equal(await historyPage.getByRole("button", { name: "Start chatting", exact: true }).isDisabled(), true);
  await historyPage.evaluate(() => (window as any).onboardingFixture.fail("host-a:import"));
  await historyPage.getByRole("alert").waitFor(); assert.equal(await choice.getAttribute("aria-checked"), "true");
  await historyPage.getByRole("button", { name: "Import selected (1)", exact: true }).click();
  await historyPage.evaluate(() => (window as any).onboardingFixture.resolve("host-a:import", { imported: [{ id: "11111111-2222-3333-4444-555555555555", threadId: "codex_fixture" }], failed: [] }));
  await historyPage.getByRole("status").filter({ hasText: "1 conversations imported" }).waitFor(); assert.equal(await choice.isDisabled(), true);
  await historyPage.screenshot({ path: `${output}/history-imported.png` });
  await historyPage.getByRole("button", { name: "Back", exact: true }).click(); await historyPage.getByRole("button", { name: "Continue", exact: true }).click();
  assert.equal(await choice.isDisabled(), true, "back/forward inside onboarding preserves imported state");
  await historyPage.setViewportSize({ width: 390, height: 844 });
  await historyPage.screenshot({ path: `${output}/history-narrow.png` });
  await historyPage.close(); assert.deepEqual(errors, []);
  // Source-first history, including delayed pages, independent errors and retained choices.
  for (const touch of [false, true]) {
    const context = await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:850},reducedMotion:"reduce"});
    const p = await context.newPage();p.setDefaultTimeout(15000);
    await p.goto(`${base}/?historyOnly=1&holdHistory=1`);
    await p.waitForFunction(()=> (window as any).onboardingFixture?.calls.includes("host-a:history:cursor"));
    assert.equal(await p.evaluate(()=> (window as any).onboardingFixture.calls.includes("host-a:status")),false,"local import never waits for online login probes");
    const source = p.locator('.agent-history-source[data-agent="cursor"]');
    assert.match(await source.innerText(),/Reading local records/);
    await p.screenshot({path:`${output}/history-loading-${touch?"touch":"desktop"}.png`});
    if(touch)await source.getByRole("button").first().tap();else await source.getByRole("button").first().click();
    await p.getByText("Reading local conversations…",{exact:true}).waitFor();
    await p.evaluate(()=> (window as any).onboardingFixture.resolve("host-a:history:cursor",{conversations:[{id:"one",title:"Cursor first",cwd:"/workspace/project",imported:false},{id:"two",title:"Cursor second",cwd:"/workspace/project",imported:false}],nextCursor:null}));
    await p.getByRole("button",{name:/^project/}).click();
    const selected=p.getByRole("checkbox",{name:/Cursor first/});await selected.click();
    await p.getByRole("button",{name:"All folders",exact:true}).click();
    await p.getByRole("button",{name:"Choose another Agent",exact:true}).click();
    await p.evaluate(()=> (window as any).onboardingFixture.resolve("host-a:history:codex",{conversations:[{id:"three",title:"Codex first",cwd:"/workspace/codex",imported:false}],nextCursor:"next"}));
    await p.waitForFunction(()=> (window as any).onboardingFixture.calls.filter((k:string)=>k==="host-a:history:codex").length===2);
    const codexSource=p.locator('.agent-history-source[data-agent="codex"]');
    assert.match(await codexSource.innerText(),/Reading local records.*1 folder · 1 conversation/s);
    await p.screenshot({path:`${output}/history-progress-${touch?"touch":"desktop"}.png`});
    await p.evaluate(()=> (window as any).onboardingFixture.fail("host-a:history:codex"));
    await codexSource.getByRole("button",{name:"Retry",exact:true}).waitFor();
    assert.match(await codexSource.innerText(),/1 folder · 1 conversation/);
    assert.match(await source.innerText(),/1 folder · 2 conversations/);
    await source.getByRole("button").first().click();await p.getByRole("button",{name:/^project/}).click();
    assert.equal(await p.getByRole("checkbox",{name:/Cursor first/}).getAttribute("aria-checked"),"true");
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    for (const theme of ["light", "dark", "lavender"]) {
      await p.evaluate(theme=>{const f=(window as any).onboardingFixture;f.setThemePreference(theme==="dark"?"dark":"light");if(theme==="lavender")f.setAppearanceThemeId("opencraft.core.lavender");},theme);
      await p.screenshot({path:`${output}/history-source-${touch?"touch":"desktop"}-${theme}.png`});
    }

    await context.close();
  }
  // Remote enrollment is visible at every local setup entry, before choosing a model.
  for (const touch of [false,true]) {
    const context=await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:850}});
    for(const entry of ["gate","management","historyOnly"]){
      const p=await context.newPage();p.setDefaultTimeout(15000);
      await p.goto(`${base}/?remoteMachines=1&holdMachines=1${entry==='gate'?'':`&${entry}=1`}`);
      const remote=p.getByRole("button",{name:"Connect remote machine",exact:true});
      await remote.waitFor();if(touch)await remote.tap();else{await remote.focus();await p.keyboard.press("Enter");}
      await p.getByText("Loading remote machine setup…",{exact:true}).waitFor();
      await p.evaluate(()=>(window as any).onboardingFixture.resolve("host-a:machines",{hubId:"fixture",ownerActorId:"human:fixture",enrollmentOrigin:"https://machine.fixture.example",machines:[]}));
      await p.getByRole("button",{name:"Generate Bash command",exact:true}).waitFor();
      assert.equal(await p.getByRole("button",{name:"Continue",exact:true}).count(),0,"remote setup does not require choosing a local model");
      assert.equal(await p.getByRole("textbox").count(),0,"the current server address is automatic, not a user input");
      assert.equal(await p.getByRole("button",{name:"Generate Bash command",exact:true}).isEnabled(),true);
      assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
      await p.screenshot({path:`${output}/remote-entry-${entry}-${touch?'touch':'desktop'}.png`});
      await p.close();
    }
    const current=await context.newPage();await current.goto(`${base}/?remoteOnly=1&remoteMachines=1`);
    const generate=current.getByRole("button",{name:"Generate Bash command",exact:true});await generate.waitFor();
    if(touch)await generate.tap();else await generate.click();
    await current.getByText("echo fixture",{exact:true}).waitFor();
    const commands=await current.evaluate(()=>(window as any).onboardingFixture.machineCommands);
    assert.deepEqual(commands.find((c:any)=>c.action==='create'),{action:"create"},"the browser cannot supply its loopback address as the remote Server origin");
    await current.close();
    const noEntrance=await context.newPage();await noEntrance.goto(`${base}/?remoteOnly=1&remoteMachines=1&noEntrance=1`);
    await noEntrance.getByText("This Server has no remote access entrance yet. A connection command will be available once remote access is ready.",{exact:true}).waitFor();
    assert(await noEntrance.getByRole("button",{name:"Generate Bash command",exact:true}).isDisabled());await noEntrance.close();
    const p=await context.newPage();await p.goto(`${base}/?remoteOnly=1`);
    await p.getByText("Remote machine setup is unavailable on this connection. Switch to your local OpenCraft or retry.",{exact:true}).waitFor();
    assert.equal(await p.evaluate(()=>(window as any).onboardingFixture.calls.some((c:string)=>c==='host-a:status'||c==='host-a:codex')),false,"direct remote entry never probes local models");
    await context.close();
  }
  for(const touch of [false,true]) {
    const context=await browser.newContext({hasTouch:touch,viewport:{width:touch?390:1100,height:900}});
    const p=await context.newPage();await p.goto(`${base}/?historyOnly=1&resumeDirectory=1&multipleHomes=1&locale=zh-CN`);
    const source=p.locator('.agent-history-source[data-agent="codex"]');await source.getByRole('button').first().click();
    const homeSelect=p.getByRole('combobox',{name:'Codex 数据目录',exact:true});
    assert.equal(await homeSelect.inputValue(),'1234567890abcdef12345678','native resume naming source is preferred for browsing');
    await p.getByRole('button',{name:/^lighthouse_ailab_operations/}).click();
    const rows=p.getByRole('checkbox');assert.equal(await rows.count(),7);
    assert.match(await rows.first().innerText(),/新增镜像制作流程/);
    const selected=p.getByRole('checkbox',{name:/新增镜像制作流程/});if(touch)await selected.tap();else await selected.click();
    const search=p.getByRole('textbox',{name:'搜索会话',exact:true});await search.fill('你好');assert.equal(await rows.count(),2);
    await search.fill('');assert.equal(await selected.getAttribute('aria-checked'),'true');
    await p.getByRole('combobox',{name:'会话排序',exact:true}).selectOption('created');assert.match(await rows.first().innerText(),/看看/);
    const status=p.getByRole('combobox',{name:'会话状态',exact:true});await status.selectOption('archived');
    await p.getByRole('button',{name:/^lighthouse_ailab_operations/}).click();assert.equal(await rows.count(),1);assert.match(await rows.first().innerText(),/Archived session/);
    await status.selectOption('active');await p.getByRole('button',{name:/^lighthouse_ailab_operations/}).click();assert.equal(await rows.count(),7);
    assert.equal(await selected.getAttribute('aria-checked'),'true');
    await p.getByRole('combobox',{name:'会话排序',exact:true}).selectOption('updated');
    for(const theme of ['light','dark','lavender']){
      await p.evaluate(theme=>{const f=(window as any).onboardingFixture;f.setThemePreference(theme==='dark'?'dark':'light');if(theme==='lavender')f.setAppearanceThemeId('opencraft.core.lavender');},theme);
      await p.evaluate(()=>Promise.all(document.getAnimations().filter(a=>a.effect?.getComputedTiming().iterations!==Infinity).map(a=>a.finished.catch(()=>{}))));
      await p.screenshot({path:`${output}/resume-directory-${touch?'touch':'desktop'}-${theme}.png`});
      assert(await p.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),'resume controls must fit the viewport');
    }
    await homeSelect.selectOption('default');
    await p.getByRole('button',{name:/^lighthouse_ailab_operations/}).click();assert.equal(await rows.count(),1);assert.match(await rows.first().innerText(),/Old prompt/);
    await homeSelect.selectOption('1234567890abcdef12345678');
    await p.getByRole('button',{name:/^lighthouse_ailab_operations/}).click();assert.equal(await rows.count(),7);
    assert.equal(await selected.getAttribute('aria-checked'),'false','same UUID in another source cannot inherit selection');
    await selected.click();await p.getByRole('button',{name:/导入所选会话/}).click();
    await p.waitForFunction(()=>(window as any).onboardingFixture.historyImports.length===1);
    assert.equal(await p.evaluate(()=>(window as any).onboardingFixture.historyImports[0].sourceId),'1234567890abcdef12345678');
    await p.evaluate(()=>(window as any).onboardingFixture.resolve('host-a:import',{imported:[{id:'11111111-2222-4333-8444-000000000001',threadId:'codex_source_fixture'}],failed:[]}));
    await context.close();
  }
  console.log(`PASS onboarding: automatic discovery, explicit keyboard/touch choices, correct model handoff, late results, host switch, sign-out, failure/retry/empty fallback; screenshots: ${output}. Agent boundary simulated.`);
} finally { await browser?.close(); await vite.close(); }
