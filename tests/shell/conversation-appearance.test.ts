import assert from "node:assert/strict";
import test from "node:test";
import { MemoryUiPreferenceStore, UiPreferencesRuntime, conversationAppearanceKey, parseConversationAppearances } from "../../packages/ui-preferences/src/index";
const key = "chat.conversationAppearances";
const a = conversationAppearanceKey("alice", "host", "same");
const b = conversationAppearanceKey("alice", "other-host", "same");
const icon = { icon: "book", color: "purple" } as const;

test("appearance identity isolates accounts and Hosts; stored values validate and normalize", () => {
  assert.notEqual(a, b);
  assert.notEqual(a, conversationAppearanceKey("bob", "host", "same"));
  assert.notEqual(conversationAppearanceKey("a:b", "c", "d"), conversationAppearanceKey("a", "b:c", "d"));
  assert.deepEqual(parseConversationAppearances({[a]:{icon:"chart", color:"#ABCDEF"}}), {[a]:{icon:"chart",color:"#abcdef"}});
  for (const appearance of [{icon:"unknown",color:"blue"},{icon:"book",color:"url(https://example.test)"},{icon:"book",color:"#12345"},null]) {
    assert.equal(parseConversationAppearances({[a]:appearance}),null);
  }
});

test("saved appearance survives reopening, reset removes only its conversation", async () => {
  const store = new MemoryUiPreferenceStore();
  const runtime = await UiPreferencesRuntime.open({ installation: store });
  await runtime.update(key, values => ({...values,[a]:icon,[b]:{icon:"code",color:"blue"}}));
  await runtime.close();
  const reopened = await UiPreferencesRuntime.open({ installation: store });
  assert.deepEqual(reopened.get(key)[a],icon);
  await reopened.update(key, values => {const next={...values};delete next[a];return next;});
  assert.equal(reopened.get(key)[a],undefined);
  assert.deepEqual(reopened.get(key)[b],{icon:"code",color:"blue"});
  await reopened.close();
});

test("concurrent windows rebase edits instead of losing another conversation", async () => {
  const store = new MemoryUiPreferenceStore();
  const first = await UiPreferencesRuntime.open({ installation: store });
  const second = await UiPreferencesRuntime.open({ installation: store });
  await Promise.all([first.update(key, values => ({...values,[a]:icon})),second.update(key, values => ({...values,[b]:icon}))]);
  const reopened = await UiPreferencesRuntime.open({ installation: store });
  assert.deepEqual(reopened.get(key),{[a]:icon,[b]:icon});
  assert.deepEqual(first.get(key),reopened.get(key));
  assert.deepEqual(second.get(key),reopened.get(key));
  await Promise.all([first.close(),second.close(),reopened.close()]);
});

test("failed save retains the confirmed appearance; queued writes keep the latest intent", async () => {
  const store = new MemoryUiPreferenceStore();
  const runtime = await UiPreferencesRuntime.open({ installation: store });
  await runtime.update(key, values => ({...values,[a]:icon}));
  const persist = store.compareAndSet.bind(store);
  store.compareAndSet = async () => {throw new Error("Disk unavailable");};
  await assert.rejects(runtime.update(key, values => ({...values,[a]:{icon:"code",color:"red"}})),/Disk unavailable/);
  assert.deepEqual(runtime.get(key)[a],icon);
  store.compareAndSet = persist;
  await Promise.all([runtime.update(key, values => ({...values,[a]:{icon:"terminal",color:"red"}})),runtime.update(key, values => ({...values,[a]:{icon:"chart",color:"green"}}))]);
  assert.deepEqual(runtime.get(key)[a],{icon:"chart",color:"green"});
  await runtime.close();
});
