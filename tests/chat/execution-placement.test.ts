import assert from "node:assert/strict";
import test from "node:test";
import { asHostId } from "@opencraft/chat-core";
import {
  createComposerController, assertComposerPlacement, isComposerSandboxTarget, isComposerWorkspaceSource, isWorkspaceRelativePath,
  type ComposerExecutionTarget, type ComposerDocument, type SubmitIntent,
} from "@opencraft/composer-core";
import { createConversationScopeRegistry, parseConversationDraftTarget, serializeConversationDraftDocument } from "@opencraft/workbench-runtime";
import { createAppServerConversationCommandPort } from "@opencraft/composer-appserver";
const environment = { version: 1, configurationId: "configured-e2b", templateId: "browser" } as const;
const source = { version: 1, kind: "git", repositoryId: "repo-a", ref: "main", relativePath: "src" } as const;
const execution: ComposerExecutionTarget = { hostId: asHostId("owner-host"), environment,
  workspace: { cwd: null, runtimeWorkspaceRoots: [], source } };
const document: ComposerDocument = { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "unsent" }] }] };

test("selection has no credential, instance, workspace identity or arbitrary URL slot", () => {
  assert.equal(isComposerSandboxTarget(environment), true);
  for (const field of ["apiKey", "sandboxId", "workspaceId", "workspace_id", "volumeId", "apiUrl"])
    assert.equal(isComposerSandboxTarget({ ...environment, [field]: "forged" }), false);
  assert.equal(isComposerSandboxTarget({ ...environment, version: 2 }), false);
  assert.equal(isComposerWorkspaceSource(source), true);
  assert.equal(isComposerWorkspaceSource({ ...source, url: "https://user:secret@example.com/repo" }), false);
  for (const ref of ["--upload-pack=bad", "a..b", "a@{b}", "a.lock", "a\nb", "/main", "a//b", "a:b", "HEAD~1"])
    assert.equal(isComposerWorkspaceSource({ ...source, ref }), false, ref);
});
test("logical paths are bounded literal relative paths, never decoded URLs", () => {
  for (const p of ["", "src", "资料/示例"]) assert.equal(isWorkspaceRelativePath(p), true);
  for (const p of ["/shared", "..", "a/../b", "a/./b", "a//b", "a/", "C:\\root", "a\0b", "%2e%2e", "a%252fb"])
    assert.equal(isWorkspaceRelativePath(p), false, p);
});
test("logical placement rejects client native paths while legacy local paths are unchanged", () => {
  assert.doesNotThrow(() => assertComposerPlacement(execution));
  assert.throws(() => assertComposerPlacement({ ...execution, workspace: { ...execution.workspace, cwd: "/shared" } }));
  assert.throws(() => assertComposerPlacement({ ...execution, workspace: { ...execution.workspace, runtimeWorkspaceRoots: ["/workspace"] } }));
  assert.doesNotThrow(() => assertComposerPlacement({ workspace: { cwd: "C:\\work", runtimeWorkspaceRoots: ["C:\\work"] } }));
});
test("retarget and persisted draft retain source and compute without replacing draft identity", () => {
  const registry = createConversationScopeRegistry({ initialDraft: null });
  try {
    const initial = registry.openDraft({ draftId: "draft", execution });
    const next = registry.retargetDraft("draft", { ...execution, environment: { ...environment, templateId: "general" } });
    assert.equal(next.scopeId, initial.scopeId);
    assert.deepEqual(next.target.execution.workspace.source, source);
    assert.equal(next.target.execution.environment?.templateId, "general");
    const encoded = serializeConversationDraftDocument(document, next.target);
    assert.deepEqual(parseConversationDraftTarget(encoded), next.target);
    const corrupt = JSON.parse(encoded!); corrupt.target.execution.environment.version = 2;
    assert.equal(parseConversationDraftTarget(JSON.stringify(corrupt)), null);
  } finally { registry.dispose(); }
});
test("unsupported placement is rejected before compile/RPC, never dispatched locally", async () => {
  let calls = 0;
  const port = createAppServerConversationCommandPort({ hostId: execution.hostId,
    client: { hostId: execution.hostId, request: async () => { calls++; throw Error("must not dispatch"); } },
    interactions: { respond: async () => {} },
  });
  const intent: SubmitIntent = { commandId: "command", clientMessageId: "message", target: {
    type: "new-thread", draftId: "draft", execution }, document, attachments: [], context: [], selections: {},
    options: { autoContext: false }, createdAt: 1 };
  await assert.rejects(port.createThread!(intent), { code: "UNSUPPORTED_PLACEMENT" });
  await assert.rejects(port.submit(intent), { code: "UNSUPPORTED_PLACEMENT" });
  assert.equal(calls, 0);
});

test("changing template or baseline never reuses an earlier failed dispatch identity", () => {
  let id = 0;
  const target = { type: "new-thread", draftId: "stable-draft", execution } as const;
  const composer = createComposerController(target, { now: () => 1, createId: () => String(++id) });
  try {
    composer.dispatch({ type: "set-document", document });
    const first = composer.createSubmitIntent();
    composer.dispatch({ type: "set-lifecycle", phase: "failed", error: "offline" });
    assert.equal(composer.createSubmitIntent().commandId, first.commandId);
    composer.dispatch({ type: "switch-target", target: { ...target, execution: {
      ...execution, environment: { ...environment, templateId: "general" },
    } }, preserveDraft: true });
    const changedTemplate = composer.createSubmitIntent();
    assert.notEqual(changedTemplate.commandId, first.commandId);
    composer.dispatch({ type: "set-lifecycle", phase: "failed", error: "offline" });
    composer.dispatch({ type: "switch-target", target: { ...target, execution: {
      ...execution, environment: { ...environment, templateId: "general" },
      workspace: { ...execution.workspace, source: { ...source, ref: "release" } },
    } }, preserveDraft: true });
    assert.notEqual(composer.createSubmitIntent().commandId, changedTemplate.commandId);
  } finally { composer.dispose(); }
});


test('capable command port preserves logical placement and stable creation identity on both entry points',async()=>{
 for(const submit of [false,true]){
  const calls:{method:string;params:any}[]=[];
  const client={hostId:execution.hostId,async request(method:string,params:any,options:any){
    options?.beforeSend?.();calls.push({method,params});
    return method==='thread/start'?{thread:{id:'created'}}:{turn:{id:'turn'}};
  }};
  const port=createAppServerConversationCommandPort({hostId:execution.hostId,client:client as any,
   supportsWorkspacePlacement:()=>true,compiler:{model:'fixture'},interactions:{async respond(){}}});
  const intent:SubmitIntent={commandId:'stable-intent',clientMessageId:'message',target:{type:'new-thread',draftId:'draft',execution},
   document,attachments:[],context:[],selections:{},options:{autoContext:false},createdAt:1};
  if(submit)await port.submit(intent);else await port.createThread!(intent);
  assert.deepEqual(calls[0]!.params.workspacePlacement,{version:1,intentId:'stable-intent',environment,source});
  assert.equal(calls[0]!.params.cwd,undefined);assert.deepEqual(calls[0]!.params.runtimeWorkspaceRoots,[]);
  assert.equal(calls.length,submit?2:1);
  if(submit)assert.equal(calls[1]!.params.workspacePlacement,undefined);
 }
});
test('placement capability revocation before send rejects without a local dispatch',async()=>{
 let supported=true,sent=0;
 const client={hostId:execution.hostId,async request(_m:string,_p:any,options:any){
  supported=false;options?.beforeSend?.();sent++;return {thread:{id:'unexpected'}};
 }};
 const port=createAppServerConversationCommandPort({hostId:execution.hostId,client:client as any,
  supportsWorkspacePlacement:()=>supported,compiler:{model:'fixture'},interactions:{async respond(){}}});
 const intent:SubmitIntent={commandId:'stable',clientMessageId:'message',target:{type:'new-thread',draftId:'draft',execution},
  document,attachments:[],context:[],selections:{},options:{autoContext:false},createdAt:1};
 await assert.rejects(port.createThread!(intent),{code:'UNSUPPORTED_PLACEMENT'});
 assert.equal(sent,0);
});
