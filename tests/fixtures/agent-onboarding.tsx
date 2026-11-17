import React, { useEffect, useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { OnboardingAgentSnapshot } from "@opencraft/appserver-protocol";
import { createIntlTestRoot } from "./intl-root";
import { AgentOnboarding } from "../../apps/workbench-web/src/components/agent-onboarding";
import { initializeAppearanceTheme, setThemePreference, setAppearanceThemeId } from "../../apps/workbench-web/src/appearance-theme";
import "../../apps/workbench-web/src/styles/app.scss";

initializeAppearanceTheme();
const queryClient = new QueryClient();
const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
const calls: string[] = [], finished: string[] = [];
const machineCommands: unknown[] = [];
const historyImports: unknown[] = [];
let signedIn = true;
let ideState = new URLSearchParams(location.search).get("ide");
let holdFinish = false;
let releaseFinish: (() => void) | null = null;
const baseAgents = (): OnboardingAgentSnapshot[] => ["codex", "cursor"].map(id => ({
  id: id as "codex" | "cursor", engineId: id, installed: true, authenticated: signedIn, account: null,
  activity: null, version: "1", installUrl: "https://example.invalid", canInstallPackage: false,
}));
function agents(): OnboardingAgentSnapshot[] {
  const state=ideState;
  const pi = new URLSearchParams(location.search).get("pi");
  if (new URLSearchParams(location.search).has("historyAll")) return ["codex", "cursor", "claude", "codebuddy", "codebuddy-ide", "pi"].map(id => ({ id: id as OnboardingAgentSnapshot["id"], engineId: id === "claude" ? "claude-code" : id === "pi" ? "pi-cli" : id, installed: true, authenticated: true, historyImport: true, version: "fixture", account: null, activity: null, canInstallPackage: false, installUrl: "https://example.invalid" }));
  return [...baseAgents(), ...(pi ? [{ id: "pi" as const, engineId: "pi-cli", displayName: "Pi", installed: true, authenticated: pi === "ready", setupCommand: "pi", account: null, activity: null, version: "1.5.2", installUrl: "https://pi.dev", canInstallPackage: true }] : []), ...(state ? [
    {id:"codebuddy" as const,engineId:"codebuddy",displayName:"CodeBuddy CLI",installed:true,authenticated:null,account:null,activity:null,version:"2",installUrl:"https://example.invalid",canInstallPackage:false},
    {id:"codebuddy-ide" as const,engineId:"codebuddy-ide",displayName:"CodeBuddy IDE",installed:true,authenticated:state!=="connect"&&state!=="sign-in",connectionRequired:state==="connect",workspaceTrusted:state!=="trust",account:null,activity:null,version:null,installUrl:"https://example.invalid",canInstallPackage:false}
  ] : [])];
}
function App() {
  const [selectedAgentId, setSelectedAgentId] = useState<string | undefined>(new URLSearchParams(location.search).get("selectedAgent") ?? undefined);
  const [disabledAgents, setDisabledAgents] = useState<string[]>([]);
  const [hostId, setHostId] = useState("host-a");
  const [presentation, setPresentation] = useState<"gate" | "sheet" | "history" | "remote" | "settings">(new URLSearchParams(location.search).has("remoteOnly") ? "remote" : new URLSearchParams(location.search).has("management") ? "settings" : new URLSearchParams(location.search).has("historyOnly") ? "history" : "gate");
  useEffect(()=>{const open=(event:Event)=>{if(event instanceof CustomEvent&&event.detail?.intent==='remote')setPresentation('remote');};window.addEventListener('opencraft:replay-agent-onboarding',open);return()=>window.removeEventListener('opencraft:replay-agent-onboarding',open);},[]);
  Object.assign(window, { onboardingFixture: {
    setSelectedAgentId,
    setIdeState(state: string) { ideState = state; return queryClient.invalidateQueries({ queryKey: ["agent-onboarding", hostId, "local"], exact: true }); },
    holdFinish() { holdFinish = true; },
    releaseFinish() { releaseFinish?.(); },
    calls, finished, machineCommands, historyImports, setDisabledAgents, setHostId, setPresentation, setThemePreference, setAppearanceThemeId,
    resolve(key: string, value: unknown) { pending.get(key)!.resolve(value); pending.delete(key); },
    fail(key: string) { pending.get(key)!.reject(new Error("Unavailable")); pending.delete(key); },
    refresh(ready: boolean) { signedIn = ready; return queryClient.invalidateQueries({ queryKey: ["agent-onboarding", hostId, "local"], exact: true }); },
  } });
  return <QueryClientProvider client={queryClient}><AgentOnboarding hostId={hostId} selectedAgentId={selectedAgentId}
    agentPreferences={{ enabled: id => !disabledAgents.includes(id), setEnabled: (id, enabled) => setDisabledAgents(current => enabled ? current.filter(value => value !== id) : [...current, id]), saving: false, failed: false }}
    catalogModels={[{ agentId: "codex", id: "codex:current", name: "Codex", isDefault: true }]}
    presentation={presentation} onClose={() => finished.push("close")} onUseModels={() => finished.push("api")}
    onFinish={async model => { if (holdFinish) await new Promise<void>(resolve => { releaseFinish = resolve; }); finished.push(model); }} request={async (method, params) => {
      if(method === "opencraft/personal-machines"){
        calls.push(`${hostId}:machines`);machineCommands.push(params);
        if(!new URLSearchParams(location.search).has("remoteMachines"))throw new Error("Unsupported");
        if((params as {action:string}).action==='create')return {hubId:"fixture",ownerActorId:"human:fixture",enrollmentOrigin:new URLSearchParams(location.search).has("noEntrance")?null:"https://machine.fixture.example",machines:[],command:"echo fixture",machineId:"fixture"} as never;
        if(new URLSearchParams(location.search).has("holdMachines"))return await new Promise((resolve,reject)=>pending.set(`${hostId}:machines`,{resolve,reject})) as never;
        return {hubId:"fixture",ownerActorId:"human:fixture",enrollmentOrigin:new URLSearchParams(location.search).has("noEntrance")?null:"https://machine.fixture.example",machines:[]} as never;
      }
      if (method === "opencraft/agents/onboarding/models") {
        const key = `${hostId}:${(params as { id: string }).id}`;
        calls.push(key);
        return await new Promise((resolve, reject) => pending.set(key, { resolve, reject })) as never;
      }
      if(method === "opencraft/agents/onboarding/history-sources")return {sources:new URLSearchParams(location.search).has("multipleHomes") ? [{id:"default",path:"/home/test/.codex",configured:true,hasNames:false},{id:"1234567890abcdef12345678",path:"/home/test/.codexl",configured:false,hasNames:true}] : []} as never;
      if (method === "opencraft/agents/onboarding/history") {
        const key = `${hostId}:history:${(params as { id:string }).id}`;
        calls.push(key);
        if(new URLSearchParams(location.search).has("resumeDirectory")) {
          const archived=(params as {archived?:boolean}).archived;
          const names=(params as {sourceId?:string}).sourceId === undefined && new URLSearchParams(location.search).has("multipleHomes") ? ["Old prompt"] : archived ? ["Archived session"] : ["新增镜像制作流程","检查生产环境问题","回应问候","你好","看下代码最新提交","你好","看看"];
          const conversations=names.map((title,index)=>({id:`11111111-2222-4333-8444-${String(index+1+(archived?20:0)).padStart(12,'0')}`,title,cwd:"/workspace/lighthouse_ailab_operations",updatedAt:new Date(Date.UTC(2026,10,15-index)).toISOString(),createdAt:new Date(Date.UTC(2026,8,1+index)).toISOString(),imported:false}));
          return {conversations,nextCursor:null,supportsArchived:true} as never;
        }
        if(new URLSearchParams(location.search).has("holdHistory")) return await new Promise((resolve,reject)=>pending.set(key,{resolve,reject})) as never;
        return { conversations: [
        { id: "11111111-2222-3333-4444-555555555555", title: "Continue my local project", cwd: "/workspace/project", updatedAt: "2026-11-13T01:00:00Z", imported: false },
        { id: "22222222-2222-3333-4444-555555555555", title: "Another conversation", cwd: "/workspace/other", updatedAt: null, imported: false },
      ], nextCursor: null } as never;
      }
      if (method === "opencraft/agents/onboarding/import") {
        calls.push(`${hostId}:import`);historyImports.push(params);
        return await new Promise((resolve, reject) => pending.set(`${hostId}:import`, { resolve, reject })) as never;
      }
      if (method === "opencraft/agents/onboarding/act" && new URLSearchParams(location.search).has("failIdeSetup")) throw new Error("Synthetic native setup failure");
      if(method === "opencraft/agents/onboarding/status") calls.push(`${hostId}:status`);
      return { agents: agents(), historyImport: new URLSearchParams(location.search).has("history") } as never;
    }} /></QueryClientProvider>;
}
createIntlTestRoot(document.getElementById("root")!, undefined, new URLSearchParams(location.search).get("locale") ?? "en-US").render(<App />);
