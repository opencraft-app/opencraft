import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { DshAppServerAdapter, promptContent } from "../apps/local-agent-host/src/dsh-appserver-adapter";
import { validateSkillInvocations } from "../apps/local-agent-host/src/dsh-skill-invocation.mjs";

const ref = { name: "repo-review", path: "/workspace/.opencraft/skills/repo-review/SKILL.md" };
const definition = { ...ref, description: "Review", content: "EXPLICIT_SKILL_INSTRUCTIONS", provider: "test", source: "project-opencraft", resourceBase: { kind: "directory", path: "/workspace/.opencraft/skills/repo-review" }, invocation: { userInvocable: true, modelInvocable: true } };

function context(skill: typeof definition | undefined = definition) {
  const agent = { session: { header: { cwd: "/workspace" } } };
  return { agent, ctx: { tools: { get: () => ({ name:"skill" }) }, agents: { get: () => agent }, skills: { get: async (name: string, options: any) => { assert.equal(name, ref.name);assert.equal(options.scope, agent);assert.equal(options.cwd,"/workspace");return skill; } } }, catalog: { prepare: () => {}, invalidate: () => {} } };
}

test("explicit Skill survives native prompt lowering and is loaded by actual DSH pre-step handler", async () => {
  const fixture = context();
  const content = await promptContent([{type:"text",text:"Review this change"},{type:"skill",...ref}], refs => validateSkillInvocations(fixture.ctx,fixture.catalog,{sessionId:"session",skills:refs}));
  assert.deepEqual(content,[{type:"text",text:"Review this change"},{type:"text",text:" /repo-review "}]);
  const native = await import(pathToFileURL(resolve("runtime/dsh/node_modules/@deepseek-ai/dsh-tool-skill/lib/index.js")).href);
  const handlers: any[] = [];
  native.apply({ ...fixture.ctx, tools:{register:()=>{}}, on:(event:string,handler:any)=>{if(event==="agent/pre-step")handlers.push(handler)} });
  const result = await handlers[0]({ agent:fixture.agent, messages:[{source:{kind:"user"},content}], signal:new AbortController().signal },async()=>({kind:"enter",messages:[]}));
  // The installed native module resolves ctx.skills, not frontend text parsing.
  assert.equal(result.kind,"enter");
  assert.equal(result.messages[0].source.kind,"skill-invocation");
  assert.equal(result.messages[0].source.name,ref.name);
  assert.match(result.messages[0].content[0].text,/EXPLICIT_SKILL_INSTRUCTIONS/u);
});

test("missing validation, stale paths and disabled Skills fail closed", async () => {
  await assert.rejects(promptContent([{type:"skill",...ref}]),/cannot validate/u);
  const f=context();
  await assert.rejects(validateSkillInvocations(f.ctx,f.catalog,{sessionId:"session",skills:[{...ref,path:"/other/SKILL.md"}]}),/path changed/u);
  const disabled=context({...definition,invocation:{userInvocable:false,modelInvocable:true}});
  await assert.rejects(validateSkillInvocations(disabled.ctx,disabled.catalog,{sessionId:"session",skills:[ref]}),/unavailable/u);
  await assert.rejects(promptContent([{type:"skill",name:"repo-review\n/other",path:ref.path}],async()=>{}),/Invalid/u);
  await assert.rejects(validateSkillInvocations({...f.ctx,tools:{get:()=>undefined}},f.catalog,{sessionId:"session",skills:[ref]}),/native Skill loader/u);
});

test("turn and steer dispatch validate selected paths before sending native session.prompt", async () => {
  const calls: any[]=[];
  const adapter=new DshAppServerAdapter({call:async(method:string,params:unknown)=>{calls.push({method,params});return {}}} as any);
  const internals=adapter as any;
  internals.ensureRuntime=async()=>{};internals.selectModel=async()=>{};internals.assertInput=async()=>{};
  internals.waitForNextTurn=()=>({promise:Promise.resolve(1),cancel:()=>{}});
  internals.inProgressTurn=()=>({id:"turn"});
  internals.livePosition.set("session",{turn:1});
  const validated:unknown[]=[];
  adapter.setSkillInvocationValidator(async(id,refs)=>{assert.equal(id,"session");validated.push(refs)});
  for(const method of ["turn/start","turn/steer"]){
    await adapter.dispatch(method,{threadId:"session",expectedTurnId:"dsh-turn-session-1",input:[{type:"skill",...ref}],clientUserMessageId:"synthetic"});
    assert.deepEqual(calls.at(-1).params.content,[{type:"text",text:" /repo-review "}]);
  }
  assert.equal(validated.length,2);
  const count=calls.length;adapter.setSkillInvocationValidator(async()=>{throw Error("stale path")});
  await assert.rejects(adapter.dispatch("turn/start",{threadId:"session",input:[{type:"skill",...ref}]}),/stale path/u);
  assert.equal(calls.length,count);
  adapter.close();
});
