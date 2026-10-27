import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "vite";
import { startLocalAgentHost } from "../../../apps/local-agent-host/src/main";
import { ModelConfigurationRepository, ModelCredentialRepository } from "../../../apps/local-agent-host/src/model-config/repository";
import { SpeechModelConfiguration } from "../../../apps/local-agent-host/src/model-config/speech";
import { SpeechTranscriptionService, validateSpeechWav } from "../../speech-transcription-service.mjs";

const { chromium } = await import(process.env.OPENCRAFT_PLAYWRIGHT_MODULE ?? "playwright");
const directory = await mkdtemp(join(tmpdir(), "opencraft-speech-model-ui-"));
delete process.env.OPENCRAFT_DSH_URL; delete process.env.OPENCRAFT_DSH_REPOSITORY;
const repository = new ModelConfigurationRepository(join(directory, "models"));
const credentials = new ModelCredentialRepository(repository.directory);
let host: Awaited<ReturnType<typeof startLocalAgentHost>> | undefined, vite: Awaited<ReturnType<typeof createServer>> | undefined, browser: any;
let expectedKey = "", paidCalls = 0;
const speech = new SpeechTranscriptionService({ configuration: new SpeechModelConfiguration(repository, credentials), fetch: async (_url: string, init: RequestInit) => {
  paidCalls++; assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${expectedKey}`);
  const input = JSON.parse(String(init.body)); assert.equal(input.model, "ep-hyasr3"); validateSpeechWav(Buffer.from(input.data, "base64"));
  return Response.json({ status: "completed", output: { text: "模型设置语音测试" } });
} });
try {
  await credentials.set("CHAT_FIXTURE", "synthetic-chat-key");
  await repository.initialize({ schemaVersion: 1, revision: 0, providers: [{ id: "deepseek-official", catalogId: "deepseek", name: "DeepSeek", protocol: "openai-completions", baseUrl: "https://api.deepseek.com", enabled: true, credentialRef: "CHAT_FIXTURE", models: [{ id: "deepseek-v4-flash", enabled: true }] }], defaultModel: { providerId: "deepseek-official", modelId: "deepseek-v4-flash" } });
  host = await startLocalAgentHost({ dataDirectory: join(directory, "agent"), modelStorageDirectory: repository.directory,
    speechModelManagement: true, dshExecutable: resolve("runtime/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js") });
  const entry = `
    import React,{useState,useEffect} from 'react';import {createIntlTestRoot as createRoot} from '/tests/fixtures/intl-root.tsx';
    import {LocalAgentSettingsService} from '/plugins/builtin-agents/src/local-agent-settings-service.ts';
    import {ModelServicesController} from '/plugins/builtin-agents/src/model-services/controller.ts';
    import {createModelServicesView} from '/plugins/builtin-agents/src/model-services/view.tsx';
    import {SpeechServiceClient,CloudSpeechInputProvider} from '/plugins/voice-input/src/cloud-speech.ts';
    import {createWebVoiceSettings} from '/plugins/voice-input/src/web-voice-settings.tsx';
    import {useUiPreferencesRuntime} from '/apps/workbench-web/src/runtime/ui-preferences-runtime.tsx';
    import {bindInteractionDensity} from '/apps/workbench-web/src/runtime/interaction-density.ts';
    import {bindTouchInteractionMode} from '/apps/workbench-web/src/runtime/pointer-modality.ts';
    import {useVoiceInputPreference} from '/apps/workbench-web/src/runtime/use-voice-input-preference.ts';
    import {initializeAppearanceTheme,setThemePreference} from '/apps/workbench-web/src/appearance-theme.ts';
    import '/apps/workbench-web/src/styles/app.scss';
    initializeAppearanceTheme();window.theme=mode=>setThemePreference(mode);window.theme('system');
    const socket=new WebSocket(${JSON.stringify(host.websocketUrl)}),ready=new Promise(resolve=>socket.addEventListener('open',resolve,{once:true}));let id=0;const pending=new Map();
    socket.onmessage=event=>{const frame=JSON.parse(event.data),call=pending.get(frame.id);if(!call)return;pending.delete(frame.id);frame.error?call.reject(new Error(frame.error.message)):call.resolve(frame.result);};
    const request=async(_host,method,params)=>{await ready;return new Promise((resolve,reject)=>{const next=++id;pending.set(next,{resolve,reject});socket.send(JSON.stringify({jsonrpc:'2.0',id:next,method,params}));});};
    const service=new LocalAgentSettingsService(request,'installation'),controller=new ModelServicesController(service),View=createModelServicesView(controller);
    const speech=new SpeechServiceClient(),VoiceSettings=createWebVoiceSettings(speech,useVoiceInputPreference);window.controller=controller;window.speech=speech;
    window.chatModels=()=>request('installation','runtime/models/list',{});
    window.results=[];const provider=new CloudSpeechInputProvider(speech);window.start=()=>{window.capture=provider.start({commit:text=>window.results.push(text),end:()=>{},error:e=>window.results.push(e.message),status:phase=>window.phase=phase});};window.stop=()=>window.capture.stop();
    function App(){const preferences=useUiPreferencesRuntime();useEffect(()=>{const density=bindInteractionDensity(document,preferences),touch=bindTouchInteractionMode(document);return()=>{density();touch()}},[preferences]);const [tab,setTab]=useState('models');return <><nav><button onClick={()=>setTab('models')}>模型设置</button><button onClick={()=>setTab('voice')}>语音设置</button></nav>{tab==='models'?<div style={{height:'calc(100vh - 40px)'}}><View/></div>:<div style={{padding:24,maxWidth:900,margin:'auto'}}><VoiceSettings/></div>}</>;}
    createRoot(document.getElementById('root')).render(<App/>);
  `;
  vite = await createServer({ configFile: false, root: process.cwd(), logLevel: "error", server: { host: "127.0.0.1", port: 0 }, plugins: [{ name: "speech-model-settings-smoke",
    resolveId: id => id === "/probe.tsx" ? id : null, load: id => id === "/probe.tsx" ? entry : null,
    configureServer(server) { server.middlewares.use((request, response, next) => {
      if (request.url?.startsWith("/__opencraft_speech/")) { void speech.handle(request, response, (req: any, mutation: boolean) => !mutation || req.headers.origin === `http://${req.headers.host}`); return; }
      if (request.url !== "/") return next(); response.setHeader("content-type", "text/html"); response.end('<meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/probe.tsx"></script>');
    }); },
  }] });
  await vite.listen(); const origin = `http://127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
  browser = await chromium.launch({ headless: true, executablePath: process.env.OPENCRAFT_CHROMIUM_EXECUTABLE,
    args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  for (const width of [1280, 390]) for (const colorScheme of ["light", "dark"]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme, hasTouch: width === 390 });
    const page = await context.newPage(), errors: string[] = [];
    page.setDefaultTimeout(15_000); page.on("pageerror", (error: Error) => errors.push(error.message));
    const name = `混元 ${width} ${colorScheme}`; expectedKey = `synthetic-${width}-${colorScheme}`;
    await page.addInitScript("window.__name=value=>value");
    await page.goto(origin); await page.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
    await page.getByRole("button", { name: "添加提供商", exact: true }).filter({ visible: true }).first().click();
    await page.getByRole("combobox", { name: "提供商用途" }).selectOption("asr");
    await page.getByRole("textbox", { name: "添加提供商", exact: true }).fill(name);
    await page.getByRole("button", { name: "添加", exact: true }).click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await page.getByLabel("API Key", { exact: true }).fill(expectedKey);
    assert.equal(await page.getByLabel("语音服务地址").getAttribute("readonly"), "");
    assert.equal(await page.getByRole("button", { name: "检查", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "获取模型", exact: true }).count(), 0);
    await page.getByRole("button", { name: "保存并收起", exact: true }).click();
    await page.locator("#model-service-connection").waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "启用提供商", exact: true }).click();
    await page.getByText("连接已配置 · 已启用", { exact: true }).waitFor();
    const doc = await repository.read(), provider = doc.providers.find(p => p.name === name)!;
    assert.equal(await credentials.resolve(provider.credentialRef!), expectedKey);
    assert.equal(await page.getByRole("button", { name: "模型操作：ep-hyasr3", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "设为默认：ep-hyasr3", exact: true }).count(), 0);
    assert.equal(await page.getByRole("switch", { name: /接收图片输入/ }).count(), 0);
    assert.ok(!(await page.evaluate(() => (window as any).chatModels())).groups.some((g: any) => g.id === provider.id));
    if (process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR}/model-services-asr-${width}-${colorScheme}.png` });
    await page.getByRole("button", { name: "语音设置", exact: true }).click();
    const methodSelect=page.getByRole("button",{name:"Recognition method",exact:true});
    assert.equal(await methodSelect.evaluate(element=>element.tagName),'BUTTON');
    if(width===390)await methodSelect.tap();else await methodSelect.click();
    const choices=page.getByRole('menu',{name:'Recognition method',exact:true});await choices.waitFor();await choices.evaluate(async el=>{getComputedStyle(el).opacity;await Promise.all(el.getAnimations().map(a=>a.finished))});
    assert.equal(await choices.getByRole('menuitemradio').count(),3);
    assert.equal(await choices.getByRole('menuitemradio',{name:'Automatic',exact:true}).getAttribute('aria-checked'),'true');
    assert.ok(await choices.evaluate(el=>parseFloat(getComputedStyle(el).borderRadius)>0));
    if(width===390) assert.ok((await choices.getByRole('menuitemradio').evaluateAll(items=>items.map(item=>item.getBoundingClientRect().height))).every(height=>height>=44));
    if(process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR)await page.screenshot({path:`${process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR}/voice-choice-open-${width}-${colorScheme}.png`});
    await page.keyboard.press('Escape');await choices.waitFor({state:'hidden'});await page.waitForFunction(()=>document.activeElement===document.querySelector('#web-speech-provider'));
    assert.equal(await methodSelect.evaluate(element=>element===document.activeElement),true);
    if(width===390)await methodSelect.tap();else await methodSelect.press('ArrowDown');
    const hunyuan=choices.getByRole('menuitemradio',{name:'Hunyuan Speech',exact:true});
    if(width===390)await hunyuan.tap();else {await choices.getByRole('menuitemradio').first().focus();await page.keyboard.press('ArrowDown');await page.waitForFunction(()=>document.activeElement?.textContent==='Hunyuan Speech');await page.keyboard.press('Enter');}
    await choices.waitFor({state:'hidden'});await page.waitForFunction(()=>document.querySelector('#web-speech-provider')?.textContent?.includes('Hunyuan Speech'));
    if(width===390)await methodSelect.tap();else await methodSelect.click();await choices.waitFor();
    await choices.getByRole('menuitemradio',{name:'Automatic',exact:true}).click();
    await choices.waitFor({state:'hidden'});
    const modelSelect = page.getByRole("button", { name: "Transcription model",exact:true });
    const modelName=await page.evaluate(providerId=>(window as any).speech.getSnapshot().models.find(model=>model.providerId===providerId&&model.modelId==='ep-hyasr3').name,provider.id);
    if(width===390)await modelSelect.tap();else await modelSelect.click();
    const modelChoice=page.getByRole('menuitemradio',{name:modelName,exact:true});
    if(width===390)await modelChoice.tap();else await modelChoice.click();
    await page.waitForFunction(() => (window as any).speech.getSnapshot().phase === "ready" && document.querySelector('#web-speech-model')?.getAttribute('disabled') === null);
    assert.deepEqual((await repository.read()).defaultModel, { providerId: "deepseek-official", modelId: "deepseek-v4-flash" });
    assert.equal(paidCalls, width === 1280 ? colorScheme === "light" ? 0 : 1 : colorScheme === "light" ? 2 : 3, "settings don't bill");
    if (process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR) await page.screenshot({ path: `${process.env.OPENCRAFT_SPEECH_UI_ARTIFACT_DIR}/speech-model-settings-${width}-${colorScheme}.png` });
    await page.evaluate(() => (window as any).start()); await page.waitForFunction(() => (window as any).phase === "listening");
    await page.waitForTimeout(500); await page.evaluate(() => (window as any).stop());
    await page.waitForFunction(() => (window as any).results.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).results), ["模型设置语音测试"]);
    await page.reload(); await page.getByRole("heading", { name: "DeepSeek", exact: true }).waitFor();
    await page.getByRole("button", { name: "语音设置", exact: true }).click();
    await page.waitForFunction(() => (window as any).speech.getSnapshot().phase === "ready");
    assert.equal(await modelSelect.innerText(),modelName);
    assert.deepEqual(await page.evaluate(()=>(window as any).speech.getSnapshot().selection),{providerId:provider.id,modelId:"ep-hyasr3"});
    assert.deepEqual(errors, []); await context.close();
  }
  console.log("PASS real DSH + model commands/credentials/CAS + shared model/voice settings + capture/ASR on desktop/touch/light/dark. Only microphone hardware and paid vendor replaced. Independent chat default, no speech in chat catalog, selection persists on reload.");
} finally { speech.close(); await browser?.close(); await vite?.close(); await host?.close(); await rm(directory, { recursive: true, force: true }); }
