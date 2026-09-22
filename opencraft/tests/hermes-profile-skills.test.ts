import assert from "node:assert/strict";
import test from "node:test";

import {
  HermesDashboardProfileSkillsHandler,
  type ProfileSkillsJournalStorage,
} from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/profile-skills-handler";
import { dispatchAppServerRequest } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/protocol";
import { BrowserHermesAppServerBridge } from "../plugins/lightvela-hermes/src/hermes-appserver-bridge/index";

class MemoryStorage implements ProfileSkillsJournalStorage {
  private readonly values = new Map<string, string>();
  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
  raw(key: string): string { return this.values.get(key) ?? ""; }
}

class FakeDashboardClient {
  readonly requests: Array<{ input: string; method: string; json: unknown }> = [];
  closed = false;

  async fetchJson<T>(input: string, init: { readonly method?: string; readonly json?: unknown } = {}): Promise<T> {
    this.requests.push({ input, method: init.method ?? "GET", json: init.json });
    if (input.startsWith("/api/skills?")) {
      return [{ name: "weather", description: "Weather", category: "utility", enabled: true, provenance: "hub", usage: 3 }] as T;
    }
    if (input.startsWith("/api/skills/content?")) return { name: "weather", path: "/home/agent/.hermes/profiles/sales/skills/weather/SKILL.md", content: "private body not copied into catalog" } as T;
    if (input.startsWith("/api/skills/hub/sources?")) {
      return {
        sources: [],
        featured: [],
        installed: { "skills-sh/acme/skills/weather": { name: "weather" } },
      } as T;
    }
    if (input === "/api/skills/hub/install") return { ok: true, name: "skills-install-1" } as T;
    if (input.startsWith("/api/actions/skills-install-1/status")) {
      return { name: "skills-install-1", running: false, exit_code: 0, lines: ["installed"] } as T;
    }
    throw new Error(`Unexpected Dashboard request: ${input}`);
  }

  close(): void { this.closed = true; }
}

const scope = { type: "profile" as const, profileId: "main" };

test("Hermes advertises Profile Skills only when the Host handler exists", async () => {
  const handler = new HermesDashboardProfileSkillsHandler("journal", new MemoryStorage());
  const result = await dispatchAppServerRequest({} as never, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {},
  }, { profileSkills: handler }) as {
    capabilities: { extensions: Record<string, { version?: number }> };
  };
  assert.equal(result.capabilities.extensions["opencraft/profile-skills"]?.version, 1);
  handler.dispose();
});

test("Profile Skills list is explicitly Profile-scoped and normalized", async () => {
  const client = new FakeDashboardClient();
  const handler = new HermesDashboardProfileSkillsHandler("journal", new MemoryStorage());
  handler.attach(client as never, "secret");
  const result = await handler.handle("skills/installed/list", { scope });
  assert.match(client.requests[0]!.input, /profile=main/u);
  assert.deepEqual(result.data, [{
    name: "weather",
    description: "Weather",
    category: "utility",
    enabled: true,
    provenance: "catalog",
    usageCount: 3,
    catalogIdentifier: "skills-sh/acme/skills/weather",
  }]);
  assert.match(result.revision, /^skills-v1-/u);
  handler.dispose();
});

test("Profile Skills operation identity survives handler recreation and prevents duplicate mutation", async () => {
  const storage = new MemoryStorage();
  const firstClient = new FakeDashboardClient();
  const first = new HermesDashboardProfileSkillsHandler("journal", storage);
  first.attach(firstClient as never, "secret");
  const accepted = await first.handle("skills/install", {
    scope,
    identifier: "official/weather",
    operationId: "operation-1",
  });
  first.detach();

  const secondClient = new FakeDashboardClient();
  const second = new HermesDashboardProfileSkillsHandler("journal", storage);
  second.attach(secondClient as never, "secret");
  const replayed = await second.handle("skills/install", {
    scope,
    identifier: "official/weather",
    operationId: "operation-1",
  });
  assert.equal(replayed.action.actionId, accepted.action.actionId);
  assert.equal(secondClient.requests.some((request) => request.input === "/api/skills/hub/install"), false);

  const events: string[] = [];
  second.subscribe((event) => events.push(event.method));
  const completed = await second.handle("skills/action/read", {
    scope,
    actionId: accepted.action.actionId,
  });
  assert.equal(completed.action.state, "succeeded");
  assert.ok(events.includes("skills/action/updated"));
  assert.ok(events.includes("skills/installed/changed"));
  assert.equal(storage.raw("journal").includes('["installed"]'), false, "provider logs must not be persisted in browser storage");
  second.dispose();
});

test("Profile Skills rejects implicit or Bot-shaped scope", async () => {
  const handler = new HermesDashboardProfileSkillsHandler("journal", new MemoryStorage());
  await assert.rejects(
    handler.handle("skills/installed/list", { scope: { type: "bot", botId: "bot-1" } }),
    /explicit Profile scope/u,
  );
  handler.dispose();
});

test("Composer Skills use explicit Profile and authoritative content path without leaking body", async () => {
  const handler = new HermesDashboardProfileSkillsHandler("journal", new MemoryStorage());
  const client = new FakeDashboardClient();handler.attach(client,"test-token");
  const result = await handler.listComposerSkills("sales","/workspace");
  assert.equal(result.data[0]?.skills[0]?.path,"/home/agent/.hermes/profiles/sales/skills/weather/SKILL.md");
  assert.equal(JSON.stringify(result).includes("private body"),false);
  assert.ok(client.requests.every(request=>request.input.includes("profile=sales")));
  await handler.validateComposerSkills("sales",[{name:"weather",path:result.data[0]!.skills[0]!.path}]);
  await assert.rejects(handler.validateComposerSkills("sales",[{name:"weather",path:"/other/SKILL.md"}]),/path changed/u);
  await assert.rejects(handler.validateComposerSkills("sales",[{name:"deleted",path:"/other/SKILL.md"}]),/no longer enabled/u);
  handler.dispose();
});

test("missing remote metadata is reported instead of guessing a filesystem path", async () => {
  const handler = new HermesDashboardProfileSkillsHandler("journal", new MemoryStorage());
  handler.attach({fetchJson:async <T>(path:string)=> (path.startsWith("/api/skills?")?[{name:"weather",enabled:true}]:{name:"weather",content:"text"}) as T, close:()=>{}},"test-token");
  const result=await handler.listComposerSkills("sales","/workspace");
  assert.equal(result.data[0]!.skills.length,0);assert.equal(result.data[0]!.errors.length,1);
  handler.dispose();
});

test("real Hermes bridge scopes Composer discovery and rejects stale Skill before gateway submission", async () => {
  const handler=new HermesDashboardProfileSkillsHandler("journal",new MemoryStorage());
  handler.attach(new FakeDashboardClient(),"test-token");
  class Socket extends EventTarget { readyState=1; send(){throw Error("Gateway must not be called for rejected Skill")};close(){} }
  const bridge=new BrowserHermesAppServerBridge(new Socket() as any,{profileScope:"sales",defaultCwd:"/workspace",profileSkills:handler});
  const result=await bridge.request("skills/list",{cwds:["/untrusted-root"]}) as any;
  assert.equal(result.data[0].cwd,"/workspace");
  assert.equal(result.data[0].skills[0].name,"weather");
  await assert.rejects(bridge.request("turn/start",{threadId:"session",input:[{type:"skill",name:"weather",path:"/wrong/SKILL.md"}]}),/path changed/u);
  bridge.dispose();handler.dispose();
});
