import assert from "node:assert/strict";
import test from "node:test";
import { WebBrowserPageRuntime } from "../apps/workbench-web/src/browser/web-browser-runtime";
import { BrowserWorkbenchCoordinator } from "../apps/workbench-web/src/browser/browser-workbench-coordinator";
import { WebBrowserDynamicToolHost } from "../apps/workbench-web/src/browser/web-browser-tool-host";
import { createConversationBindingStore } from "@opencraft/workbench-runtime";
import { createConversationKey } from "@opencraft/chat-core";

test("background tab stays task-owned, does not open a panel, and releases operation lease on failure", async () => {
  let acquired=0,released=0,closed=0,forgotten=0,opened=0;
  const storage={getItem:()=>null,setItem:()=>{}};
  const surfaces:any={
    navigate:()=>true, setRoot(){}, stop(){}, commit(){}, block(){},park(){},
    close(){closed++;},forget(){forgotten++;},dispose(){},
    acquireUse(){acquired++;return ()=>{released++;};}, waitUntilReady:async()=>{},
    automation:()=>({inspect:async()=>{throw new Error("synthetic document changed");}}),
  };
  const pages=new WebBrowserPageRuntime(surfaces,null,()=>null,storage);
  const bindings=createConversationBindingStore();
  const panels:any={open:()=>{opened++;return{id:"panel"};},close(){},dispatch(){},ensureOwner(){}};
  const workbench=new BrowserWorkbenchCoordinator(pages,panels,bindings,storage);
  const tool=new WebBrowserDynamicToolHost(pages,workbench);
  const context={hostId:"h",threadId:"t",turnId:"turn",callId:"call"};
  bindings.bind("scope" as never,createConversationKey("h","t"));
  const tab=tool.open(context,{url:"https://example.com",visible:false}) as {tabId:string};
  assert.equal(opened,0);
  assert.equal((await tool.browserUse(context,{action:"list_tabs"}) as any).tabs.length,1);
  await assert.rejects(tool.browserUse(context,{action:"inspect",tab_id:tab.tabId}) as Promise<unknown>,/synthetic document changed/);
  assert.equal(acquired,1);assert.equal(released,1);
  await assert.rejects(tool.browserUse({...context,threadId:"other"},{action:"inspect",tab_id:tab.tabId}) as Promise<unknown>);
  await tool.browserUse(context,{action:"close",tab_id:tab.tabId});
  assert.equal(closed,1);assert.equal(forgotten,1);
  assert.equal(pages.list().length,0);
  pages.dispose();
});
