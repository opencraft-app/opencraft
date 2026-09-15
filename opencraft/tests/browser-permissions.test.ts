import assert from "node:assert/strict";
import test from "node:test";
import { BrowserPermissionPolicy } from "../apps/workbench-electron/src/browser-permissions";
test("permission decisions are isolated by partition/origin/type and never grant unsupported access", async () => {
  let state: Record<string, boolean> = {}, prompts = 0;
  const policy = new BrowserPermissionPolicy({ read: () => state, write: value => { state = value; } },
    async () => { prompts++; return {allow:true,remember:true}; });
  assert.equal(await policy.request("p", "https://a.example", "camera", () => true), true);
  assert.equal(policy.check("other", "https://a.example", "camera"), false);
  assert.equal(policy.check("p", "https://b.example", "camera"), false);
  assert.equal(policy.check("p", "https://a.example", "microphone"), false);
  assert.equal(await policy.request("p", "https://a.example", "camera", () => true), true);
  assert.equal(await policy.request("p", "https://a.example", "clipboard-read", () => true), false);
  assert.equal(prompts, 1);
  policy.revoke("p", "https://a.example");
  assert.equal(policy.check("p", "https://a.example", "camera"), false);
});
test("navigation or revocation while permission prompt is open cannot persist a late grant", async () => {
  let state: Record<string, boolean> = {}, resolve!: (value: {allow:boolean;remember:boolean}) => void;
  const policy = new BrowserPermissionPolicy({read:()=>state,write:value=>{state=value;}},
    () => new Promise(r=>{resolve=r;}));
  const pending = policy.request("p", "https://a.example", "camera", ()=>true);
  policy.revoke("p","https://a.example");
  resolve({allow:true,remember:true});
  assert.equal(await pending,false);
  assert.deepEqual(state,{});
});
