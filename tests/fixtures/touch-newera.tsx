import * as DropdownMenu from "@opencraft/design-system-web/dropdown-menu";
import React, { useEffect, useState } from "react";
import { createConversationKey } from "@opencraft/chat-core";
import { createComposerController, composerDocumentToPlainText } from "@opencraft/composer-core";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import * as themes from "@opencraft/design-system/theme-engine";
import { ScrollToBottomButton } from "../../apps/workbench-web/src/components/scroll-to-bottom-button";
import { ChatSettings } from "../../apps/workbench-web/src/components/chat-settings";
import { openWorkbenchUiPreferences, UiPreferencesProvider, useUiPreferencesRuntime } from "../../apps/workbench-web/src/runtime/ui-preferences-runtime";
import { bindInteractionDensity } from "../../apps/workbench-web/src/runtime/interaction-density";
import { createIntlTestRoot } from "./intl-root";
import { createVoiceInputAction } from "../../plugins/voice-input/src/voice-input-action";
import type { SpeechInputObserver } from "../../plugins/voice-input/src/speech-input-provider";
import "../../apps/workbench-web/src/styles/app.scss";
const params = new URLSearchParams(location.search), mode = params.get("mode") === "dark" ? "dark" : "light";
const palettes = {
  neutral: themes.opencraftNeutralThemePalette, canvas: themes.opencraftCanvasThemePalette,
  frost: themes.frostThemePalette, lavender: themes.lavenderThemePalette,
  mist: themes.mistThemePalette, graphite: themes.graphiteThemePalette,
};
const paletteName = params.get("palette") ?? "neutral";
const palette = palettes[paletteName as keyof typeof palettes];
if (!palette) throw new Error(`Unknown fixture palette: ${paletteName}`);
document.documentElement.dataset.theme = mode;
for (const [key, value] of Object.entries(themes.buildOpenCraftThemeCssProperties(mode, palette[mode]))) document.documentElement.style.setProperty(key, value);
const controller = createComposerController({ type: "existing-thread", key: createConversationKey("local", "test") }, { now: () => 100, createId: () => "draft" });
let speechObserver: SpeechInputObserver | null = null;
const Voice = createVoiceInputAction({ id: "layout-fixture", isAvailable: () => true, start(observer) {
  speechObserver = observer;
  return { phase: "starting", stop() {}, cancel() {} };
} });
const mutations = Object.freeze({ insertText: controller.insertText, focus: controller.focus, beginTransientTextInput: controller.beginTransientTextInput });
const submitted: string[] = [];
Object.assign(window, { dictationFixture: {
  submitted,
  ready: () => speechObserver?.status?.("listening"),
  complete: (text = "识别后的文字") => { speechObserver?.commit(text); speechObserver?.end(); },
  fail: () => speechObserver?.recover?.({ code: "network", message: "Synthetic recognition retry" }, () => {}),
  level: (level: number) => speechObserver?.level?.(level),
} });
function Fixture() {
 const preferences = useUiPreferencesRuntime();
 const [composerVisible,setComposerVisible] = useState(true);
 const [working,setWorking] = useState(false);
 const [recovering,setRecovering] = useState(false);
 const [queueVisible,setQueueVisible] = useState(false);
 useEffect(() => {
   Object.assign(window, { setRecovering, setComposerVisible, composerController: controller, setWorking, setQueue: setQueueVisible, setNewera: (on: boolean) => preferences.set("chat.touchNewera", on), setTouch: (on: boolean) => preferences.set("interface.touchFriendly", on ? "on" : "off") });
   return bindInteractionDensity(document, preferences);
 }, [preferences]);
 return <main style={{ minHeight: "100dvh", padding: 12, background: "var(--color-background-primary)", color: "var(--color-text)" }}>
  <div className="thread-scroll-footer" style={{ position: "relative", maxWidth: 760, margin: "80px auto 24px" }}>
    <div className="thread-scroll-footer__gradient" />
    <div aria-hidden style={{ position: "absolute", inset: 0, color: "var(--color-text)", background: "linear-gradient(90deg,transparent,color-mix(in srgb,blue 10%,transparent))" }}>正在滚动的会话正文。在透明输入框后仍应模糊，不能干扰输入。</div>
    {params.has("scrollControl") && <div className="thread-scroll-to-bottom-anchor" style={{ marginTop: 100 }}><div aria-hidden style={{position:"absolute",insetInlineEnd:"50%",transform:"translateX(50%)",bottom:16,width:120,height:64,background:"linear-gradient(90deg, transparent, color-mix(in srgb, var(--color-text) 20%, transparent), transparent)",fontSize:14}}>会话正文 · 正在阅读</div><ScrollToBottomButton show label="回到底部" showWorkingDots={working} onClick={() => { (window as any).scrollClicks = ((window as any).scrollClicks ?? 0) + 1; }} /></div>}
    {composerVisible && <OpenCraftComposer isRecovering={recovering} controller={controller} selectionCatalog={params.has("pickerFocus") ? {
      models:["Alpha","Beta",...Array.from({length:16},(_,i)=>`Model ${i}`)].map((label,index)=>({id:label,value:label,label,description:null,isDefault:index===0,defaultEffort:"medium",efforts:["medium","high"].map(value=>({value,label:value,description:null}))})),
      permissionProfiles:["read-only","full"].map(value=>({id:value,value,label:value,description:null,disabled:false,mode:value as "read-only"|"full"})),
    } : undefined} queuedSubmissions={queueVisible ? [{id: "queued-one", preview: "输入框与队列使用同一玻璃材质",state:"queued",operation:"idle",actionable:true,editableContent:{document:controller.getSnapshot().draft.document,attachments:[],context:[]}}] : []} onSubmit={intent => { if (params.has("dictation")) submitted.push(composerDocumentToPlainText(intent.document)); return false; }} onCancel={() => {}} mentionSuggestionsEnabled={false} shortcutCommands={[{ name: "help", description: "Help" }]}
      addMenuContent={params.has("addMenu") ? close => <>
        <DropdownMenu.Sub><DropdownMenu.SubTrigger className="opencraft-composer-selection-menu__item">连接器</DropdownMenu.SubTrigger>
          <DropdownMenu.Portal><DropdownMenu.SubContent className="opencraft-composer-selection-menu"><DropdownMenu.Item className="opencraft-composer-selection-menu__item">Fixture connector</DropdownMenu.Item></DropdownMenu.SubContent></DropdownMenu.Portal>
        </DropdownMenu.Sub>
        <DropdownMenu.Item className="opencraft-composer-selection-menu__item" onSelect={() => close(() => document.getElementById("outside-input")?.focus())}>设定持续目标</DropdownMenu.Item>
      </> : undefined}
      endActions={params.has("dictation") ? <Voice mutations={mutations} disabled={false} platform="web" /> : <button className="opencraft-composer-icon-button opencraft-voice-input-action" data-voice-input-state="error" aria-label="Fixture microphone">🎤</button>} />}
  </div>
  {params.has("pickerFocus") && <input id="outside-input" aria-label="Outside input" style={{position:"fixed",left:4,top:4,width:60}} />}
  <ChatSettings />
 </main>;
}
function EntryFixture() {
 const [preferences,setPreferences] = useState<Awaited<ReturnType<typeof openWorkbenchUiPreferences>> | null>(null);
 useEffect(() => {
   let disposed=false;
   let current: Awaited<ReturnType<typeof openWorkbenchUiPreferences>> | null=null;
   void openWorkbenchUiPreferences({presentation:params.get("entry")==="embedded"?"embedded":"standalone"}).then(runtime=>{
     if(disposed){void runtime.close();return;}
     current=runtime;setPreferences(runtime);
   });
   return ()=>{disposed=true;void current?.close();};
 },[]);
 return preferences ? <UiPreferencesProvider runtime={preferences}><Fixture /></UiPreferencesProvider> : null;
}
createIntlTestRoot(document.getElementById("root")!, undefined, "zh-CN").render(params.has("entry") ? <EntryFixture /> : <Fixture />);
