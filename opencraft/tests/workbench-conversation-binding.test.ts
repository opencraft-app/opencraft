import assert from "node:assert/strict";
import test from "node:test";

import { asHostId, createConversationKey } from "@opencraft/chat-core";
import { composerDocumentToPlainText } from "@opencraft/composer-core";
import {
  asConversationScopeId,
  createConversationBindingStore,
  createConversationScopeLeaseRegistry,
  createConversationScopeRegistry,
  createConversationViewRegistry,
} from "@opencraft/workbench-runtime";

test("a Draft Conversation Scope keeps its identity after receiving a canonical Thread", () => {
  const store = createConversationBindingStore();
  const scopeId = asConversationScopeId("client-new-thread:1");
  const key = createConversationKey("ssh:alpha", "thread-9");

  store.register(scopeId, asHostId("ssh:alpha"));
  const binding = store.bind(scopeId, key);

  assert.equal(binding.scopeId, scopeId);
  assert.deepEqual(binding.conversationKey, key);
  assert.equal(store.findScope(key), scopeId);
});

test("inactive Conversation Views are bounded and may discard an empty input slot", () => {
  const disposed: string[] = [];
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "id" },
    maxInactiveViews: 1,
    onDisposeView: (viewId) => disposed.push(viewId),
  });
  const first = asConversationScopeId("scope-first");
  const second = asConversationScopeId("scope-second");
  const firstTarget = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-first"),
  } as const;
  const secondTarget = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-second"),
  } as const;
  leases.ensure(first, asHostId("local"), firstTarget);
  leases.ensure(second, asHostId("local"), secondTarget);
  const firstComposer = views.ensure("view-first", first, asHostId("local"), firstTarget).composer;
  views.ensure("view-second", second, asHostId("local"), secondTarget);

  assert.deepEqual(disposed, ["view-first"]);
  assert.equal(views.get("view-first"), null);
  assert.throws(() => firstComposer.createSubmitIntent(), /disposed/u);
  views.dispose();
  leases.dispose();
});

test("two Views of one Conversation Scope keep independent Composer documents", () => {
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => crypto.randomUUID() },
  });
  const scopeId = asConversationScopeId("conversation:shared");
  const target = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-shared"),
  } as const;
  leases.ensure(scopeId, asHostId("local"), target);
  const first = views.ensure("view-a", scopeId, asHostId("local"), target).composer;
  const second = views.ensure("view-b", scopeId, asHostId("local"), target).composer;
  first.dispatch({
    type: "set-document",
    document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "only A" }] }] },
  });
  assert.equal(composerDocumentToPlainText(first.getSnapshot().draft.document), "only A");
  assert.equal(composerDocumentToPlainText(second.getSnapshot().draft.document), "");
  assert.equal(leases.get(scopeId)?.retainCount, 2);
  views.dispose();
  leases.dispose();
});

test("automatic Scope eviction reports cleanup failure without aborting its caller", () => {
  const errors: AggregateError[] = [];
  const leases = createConversationScopeLeaseRegistry({
    maxInactiveScopes: 0,
    onDisposeScope: () => { throw new Error("resource cleanup failed"); },
    onDisposeError: (error) => errors.push(error),
  });
  assert.doesNotThrow(() => leases.ensure(
    asConversationScopeId("scope-evicted"),
    asHostId("local"),
    {
      type: "existing-thread",
      key: createConversationKey("local", "thread-evicted"),
    },
  ));
  assert.equal(errors.length, 1);
  assert.match(errors[0]?.message ?? "", /scope-evicted/u);
  leases.dispose();
});

test("Conversation Scope Host ownership and canonical Thread ownership are immutable", () => {
  const store = createConversationBindingStore();
  const first = asConversationScopeId("view-1");
  const second = asConversationScopeId("view-2");
  const key = createConversationKey("local", "thread-1");
  store.register(first, asHostId("local"));
  store.bind(first, key);

  assert.throws(
    () => store.register(first, asHostId("remote")),
    /already belongs to Host local/u,
  );
  assert.throws(
    () => store.bind(second, key),
    /already bound to Conversation Scope/u,
  );
});

test("promotion aliases survive application restart without becoming authoritative history", () => {
  let persisted: readonly { scopeId: string; hostId: string; threadId: string | null }[] = [];
  const persistence = {
    load: () => persisted,
    save: (bindings: typeof persisted) => { persisted = structuredClone(bindings); },
  };
  const scopeId = asConversationScopeId("client-new-thread:persisted");
  const key = createConversationKey("ssh:alpha", "thread-persisted");
  const first = createConversationBindingStore({ persistence });
  first.register(scopeId, key.hostId);
  first.bind(scopeId, key);
  first.dispose();

  const restarted = createConversationBindingStore({ persistence });
  assert.equal(restarted.findScope(key), scopeId);
  assert.deepEqual(restarted.resolve(scopeId)?.conversationKey, key);
  restarted.dispose();
});

test("embedded Conversation bindings stay in memory and never enter durable aliases", () => {
  let persisted: readonly { scopeId: string; hostId: string; threadId: string | null }[] = [];
  const store = createConversationBindingStore({
    persistence: {
      load: () => persisted,
      save: (bindings) => { persisted = structuredClone(bindings); },
    },
  });
  const durableScope = asConversationScopeId("scope-durable");
  const embeddedScope = asConversationScopeId("scope-embedded");
  const durableKey = createConversationKey("local", "thread-durable");
  const embeddedKey = createConversationKey("lightvela", "thread-embedded");

  store.register(durableScope, durableKey.hostId);
  store.bind(durableScope, durableKey);
  store.register(embeddedScope, embeddedKey.hostId, { persistent: false });
  store.bind(embeddedScope, embeddedKey);

  assert.equal(store.findScope(embeddedKey), embeddedScope);
  assert.deepEqual(persisted, [{
    scopeId: durableScope,
    hostId: durableKey.hostId,
    threadId: durableKey.threadId,
  }]);
  store.remove(embeddedScope);
  assert.deepEqual(persisted, [{
    scopeId: durableScope,
    hostId: durableKey.hostId,
    threadId: durableKey.threadId,
  }]);
  store.dispose();
});

test("independent retainers with the same reason do not release each other", () => {
  const leases = createConversationScopeLeaseRegistry({});
  const scopeId = asConversationScopeId("conversation:retainers");
  leases.ensure(scopeId, asHostId("local"), {
    type: "existing-thread",
    key: createConversationKey("local", "thread-retainers"),
  });
  const releaseFirst = leases.retain(scopeId, "route");
  const releaseSecond = leases.retain(scopeId, "route");
  assert.equal(leases.get(scopeId)?.retainCount, 2);
  releaseFirst();
  assert.equal(leases.get(scopeId)?.retainCount, 1);
  assert.equal(leases.close(scopeId), false);
  releaseSecond();
  assert.equal(leases.close(scopeId), true);
  leases.dispose();
});

test("leaving a Draft route hides it without discarding its retained document identity", () => {
  const scopes = createConversationScopeRegistry({
    initialDraft: {
      draftId: "draft-retained",
      execution: {
        hostId: "local",
        workspace: { cwd: "/workspace", runtimeWorkspaceRoots: ["/workspace"] },
      },
    },
  });
  scopes.deactivateDraft();
  assert.equal(scopes.getActiveDraft(), null);
  assert.notEqual(scopes.getDraft("draft-retained"), null);
  scopes.activateDraft("draft-retained");
  assert.equal(scopes.getActiveDraft()?.id, "draft-retained");
  scopes.dispose();
});

test("explicit Composer selections survive View recreation through the Scope lease", () => {
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "id" },
  });
  const scopeId = asConversationScopeId("scope-selections");
  const target = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-selections"),
  } as const;
  leases.ensure(scopeId, asHostId("local"), target);

  const first = views.ensure("view-selections-1", scopeId, asHostId("local"), target).composer;
  assert.deepEqual(first.getSnapshot().draft.selections, {});
  first.dispatch({
    type: "set-selections",
    patch: { model: "dsh-model:deepseek:test", effort: "high", permissionProfile: null },
  });
  assert.equal(leases.readSelections(scopeId)?.model, "dsh-model:deepseek:test");
  assert.equal(leases.readSelections(scopeId)?.permissionProfile, null);

  assert.ok(views.close("view-selections-1"));
  const second = views.ensure("view-selections-2", scopeId, asHostId("local"), target).composer;
  assert.equal(second.getSnapshot().draft.selections.model, "dsh-model:deepseek:test");
  assert.equal(second.getSnapshot().draft.selections.effort, "high");
  assert.equal(second.getSnapshot().draft.selections.permissionProfile, null);
  views.dispose();
  leases.dispose();
});

test("a Conversation Scope without explicit selections keeps fresh Composer drafts empty", () => {
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "id" },
  });
  const scopeId = asConversationScopeId("scope-unselected");
  const target = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-unselected"),
  } as const;
  leases.ensure(scopeId, asHostId("local"), target);
  const composer = views.ensure("view-unselected", scopeId, asHostId("local"), target).composer;
  assert.deepEqual(composer.getSnapshot().draft.selections, {});
  assert.equal(leases.readSelections(scopeId), null);
  views.dispose();
  leases.dispose();
});

test("promoting a Draft target restores Scope selections into the fresh Composer draft", () => {
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({
    scopeLeases: leases,
    composerServices: { now: () => 1, createId: () => "id" },
  });
  const scopeId = asConversationScopeId("scope-promotion");
  const draftTarget = {
    type: "new-thread",
    execution: { hostId: asHostId("local") },
  } as const;
  const threadTarget = {
    type: "existing-thread",
    key: createConversationKey("local", "thread-promoted"),
  } as const;
  leases.ensure(scopeId, asHostId("local"), draftTarget);
  const composer = views.ensure("view-promotion", scopeId, asHostId("local"), draftTarget).composer;
  composer.dispatch({ type: "set-selections", patch: { model: "dsh-model:deepseek:prod" } });

  views.bindScopeTarget(scopeId, threadTarget);
  assert.equal(leases.readSelections(scopeId)?.model, "dsh-model:deepseek:prod");
  assert.equal(composer.getSnapshot().draft.selections.model, "dsh-model:deepseek:prod");
  views.dispose();
  leases.dispose();
});
