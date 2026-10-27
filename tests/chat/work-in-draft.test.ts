import { FULL_WORKBENCH_PRESENTATION, EMBEDDED_CORE_CHAT_PRESENTATION } from "../../apps/workbench-web/src/workbench-presentation-policy";
import assert from "node:assert/strict";
import test from "node:test";
import { QueryClient } from "@tanstack/react-query";
import { asHostId } from "@opencraft/chat-core";
import { composerDocumentToPlainText } from "@opencraft/composer-core";
import { HostRuntimeRegistry, createConversationBindingStore, createConversationScopeLeaseRegistry, createConversationScopeRegistry, createConversationViewRegistry, createConversationActivationCoordinator, createWorkbenchCoordinator, createWorkbenchDraftLocation, type HostConnectionProfile } from "@opencraft/workbench-runtime";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction";

Object.defineProperty(globalThis, "window", { configurable: true, value: { location: { href: "http://localhost/" }, history: { state: null }, localStorage: { setItem() {}, removeItem() {} } } });
const { createWebWorkbenchCommands } = await import("../../apps/workbench-web/src/runtime/workbench-application-services");
const identity = { machineId: "12345678-1234-4123-8123-123456789abc", name: "machine", platform: "linux" as const };
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => resolve = done); return { promise, resolve }; }
async function fixture(targetProject = false, targetDirectory = targetProject, presentation = FULL_WORKBENCH_PRESENTATION) {
  const profiles = ["local", "fixture-secondary", "other", "latest"].map((hostId): HostConnectionProfile => ({ hostId, machineIdentity: hostId === "local" || hostId === "fixture-secondary" ? identity : { ...identity, machineId: hostId === "other" ? "22345678-1234-4123-8123-123456789abc" : "32345678-1234-4123-8123-123456789abc" }, displayName: hostId, providerId: "fake", providerConfig: {}, providerConfigVersion: 1, hostKind: "local", enabled: true, autoConnect: false, includeInSidebar: true, credentialRef: null, transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: ["/default"], revision: 0 }));
  const holds = new Map<string, Promise<void>>();
  const calls = new Map<string, number>();
  let projectCreates = 0;
  const registry = new HostRuntimeRegistry(profiles.map(profile => ({ descriptor: { hostId: profile.hostId, label: profile.displayName, kind: profile.hostKind, transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: ["/default"] }, createRuntime: () => ({ async connect() { const call = (calls.get(profile.hostId) ?? 0) + 1; calls.set(profile.hostId, call); await (holds.get(`${profile.hostId}:${call}`) ?? holds.get(profile.hostId)); }, async dispose() {}, async acquireThread() { throw new Error("unexpected Thread"); }, resources: { fileSystem: { async getMetadata() { if (!targetDirectory) throw Object.assign(new Error("missing folder"), { code: -32603 }); return { isDirectory: true }; } }, projects: { async create() { projectCreates++; throw new Error("selection must not create projects"); }, async list() { return { data: targetProject ? [{ id: "target-project", roots: [{ path: "/project" }] }] : [], nextCursor: null }; } } } }) })));
  const scopes = createConversationScopeRegistry({ initialDraft: { draftId: "initial", execution: { hostId: asHostId("local"), workspace: { cwd: "/project", runtimeWorkspaceRoots: ["/project"], projectId: "source-project" } } } });
  const location = createWorkbenchDraftLocation("local", "initial");
  const coordinator = createWorkbenchCoordinator(registry, location);
  const bindings = createConversationBindingStore();
  const leases = createConversationScopeLeaseRegistry({});
  const views = createConversationViewRegistry({ scopeLeases: leases, composerServices: { now: Date.now, createId: () => crypto.randomUUID() } });
  const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
  const navigation = createWorkbenchNavigationTransaction(location, activation, scopes, { mode: "memory", presentation });
  activation.mountInitial(location, navigation.getSnapshot().routeScopeId);
  const commands = createWebWorkbenchCommands({ presentation, registry, coordinator, activation, scopes, views, navigation, queryClient: new QueryClient(), hostProfiles: { getSnapshot: () => ({ revision: 0, profiles }), subscribe: () => () => {}, put: async () => {}, remove: async () => false, close() {} }, createHostRegistration: () => { throw new Error("unexpected registration"); }, connectionProviders: {} } as any);
  const composer = () => views.get(coordinator.getSnapshot().viewId!)!.composer;
  composer().dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "keep my draft" }] }] } });
  return { profiles, calls, get projectCreates() { return projectCreates; }, commands, scopes, coordinator, composer, holds, async close() { navigation.dispose(); activation.dispose(); views.dispose(); leases.dispose(); scopes.dispose(); coordinator.dispose(); bindings.dispose(); await registry.dispose(); } };
}

test("switching Agent preserves text/cwd/project and applies the requested model", async () => {
  const f = await fixture();
  try {
    await f.commands.selectHost("fixture-secondary", { model: "secondary-model", effort: "high", serviceTier: "priority" });
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
    assert.deepEqual(f.scopes.getActiveDraft()!.target.execution.workspace, { cwd: "/project", runtimeWorkspaceRoots: ["/project"], projectId: "source-project" });
    assert.equal(f.composer().getSnapshot().draft.selections.model, "secondary-model");
    assert.equal(f.composer().getSnapshot().draft.selections.serviceTier, "priority");
    assert.equal(f.projectCreates, 0);
  } finally { await f.close(); }
});

for (const exists of [true, false]) test(`switching machine preserves text; project ${exists ? "remaps when present" : "clears when absent"}`, async () => {
  const f = await fixture(exists);
  try {
    await f.commands.selectHost("other");
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.cwd, exists ? "/project" : null);
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.projectId, exists ? "target-project" : undefined);
    assert.equal(f.projectCreates, 0);
  } finally { await f.close(); }
});

test("a held switch and its late model selection cannot override the newer machine", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("fixture-secondary", held.promise);
    const old = f.commands.selectHost("fixture-secondary", { model: "late-model", effort: null });
    await f.commands.selectHost("latest");
    f.composer().dispatch({ type: "set-document", document: { version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: "keep my draft newest" }] }] } });
    held.resolve(); await old;
    assert.equal(f.coordinator.getSnapshot().selectedHostId, "latest");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "latest");
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft newest");
    assert.notEqual(f.composer().getSnapshot().draft.selections.model, "late-model");
  } finally { held.resolve(); await f.close(); }
});

test("a held navigation keeps the original visible Draft, and a newer selection cancels it", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("fixture-secondary:2", held.promise);
    const old = f.commands.selectHost("fixture-secondary", { model: "late-model", effort: null });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.scopes.getActiveDraft()!.id, "initial");
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
    await f.commands.selectHost("latest");
    held.resolve(); await old;
    assert.equal(f.coordinator.getSnapshot().selectedHostId, "latest");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "latest");
  } finally { held.resolve(); await f.close(); }
});

test("editing the project during a held switch retains the newer workspace choice", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("fixture-secondary", held.promise);
    const old = f.commands.selectHost("fixture-secondary");
    f.scopes.retargetDraft("initial", { hostId: asHostId("local"), workspace: { cwd: "/new-project", runtimeWorkspaceRoots: ["/new-project"] } });
    held.resolve(); await old;
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "local");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.cwd, "/new-project");
  } finally { held.resolve(); await f.close(); }
});

test("choosing a model on the current Agent cancels a held engine switch", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("fixture-secondary", held.promise);
    const old = f.commands.selectHost("fixture-secondary", { model: "late-model", effort: "high" });
    await f.commands.selectHost("local", { model: "new-local-model", effort: null, serviceTier: null });
    held.resolve(); await old;
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "local");
    assert.equal(f.composer().getSnapshot().draft.selections.model, "new-local-model");
    assert.equal(f.composer().getSnapshot().draft.selections.serviceTier, null);
  } finally { held.resolve(); await f.close(); }
});

for (const catalog of [true, false]) test(`target directory existence overrides ${catalog ? "a stale catalog" : "a missing catalog"}`, async () => {
  const f = await fixture(catalog, !catalog);
  try {
    await f.commands.selectHost("other");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.cwd, catalog ? null : "/project");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.projectId, undefined);
    assert.deepEqual(f.scopes.getActiveDraft()!.target.execution.workspace.runtimeWorkspaceRoots, catalog ? [] : ["/project"]);
    assert.equal(f.projectCreates, 0);
  } finally { await f.close(); }
});

test("A to held B to A cancels B and preserves the original draft", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("other", held.promise);
    const old = f.commands.selectHost("other");
    await f.commands.selectHost("local");
    held.resolve(); await old;
    assert.equal(f.coordinator.getSnapshot().selectedHostId, "local");
    assert.equal(f.scopes.getActiveDraft()!.id, "initial");
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
  } finally { held.resolve(); await f.close(); }
});

test("same-machine engine switch preserves inline images, staged files, context and composer choices", async () => {
  const f = await fixture();
  try {
    const inline = { id: "image", name: "image.png", mimeType: "image/png", size: 4, uri: "data:image/png;base64,dGVzdA==", lifecycle: "ready" as const, error: null };
    const file = { ...inline, id: "file", name: "file.txt", mimeType: "text/plain", uri: "file:///project/file.txt" };
    const reference = { id: "context", kind: "file" as const, title: "file.txt", uri: "file:///project/file.txt", visible: true };
    f.composer().dispatch({ type: "add-attachment", attachment: inline });
    f.composer().dispatch({ type: "add-attachment", attachment: file });
    f.composer().dispatch({ type: "add-context", reference });
    f.composer().dispatch({ type: "set-selections", patch: { mode: "plan", permissionProfile: ":workspace_roots" } });
    f.composer().dispatch({ type: "set-options", patch: { autoContext: false } });
    await f.commands.selectHost("fixture-secondary", { model: "secondary-model", effort: "high" });
    const draft = f.composer().getSnapshot().draft;
    assert.deepEqual(draft.attachments.map(attachment => [attachment.id, attachment.uri, attachment.lifecycle]), [["image", inline.uri, "ready"], ["file", file.uri, "ready"]]);
    assert.deepEqual(draft.context, [reference]);
    assert.equal(draft.selections.mode, "plan");
    assert.equal(draft.selections.permissionProfile, ":workspace_roots");
    assert.equal(draft.options.autoContext, false);
  } finally { await f.close(); }
});

test("an unfinished attachment remains visible as interrupted; another machine's staged file cannot be sent", async () => {
  const f = await fixture();
  try {
    f.composer().dispatch({ type: "add-attachment", attachment: { id: "pending", name: "pending.png", mimeType: "image/png", size: 4, uri: null, lifecycle: "processing", error: null } });
    f.composer().dispatch({ type: "add-attachment", attachment: { id: "file", name: "file.txt", mimeType: "text/plain", size: 4, uri: "file:///project/file.txt", lifecycle: "ready", error: null } });
    await f.commands.selectHost("other");
    const snapshot = f.composer().getSnapshot();
    assert.equal(snapshot.draft.attachments.length, 2);
    assert.equal(snapshot.draft.attachments[0]!.metadata!.workInAttachmentError, "interrupted");
    assert.equal(snapshot.draft.attachments[1]!.metadata!.workInAttachmentError, "machine-changed");
    assert.equal(snapshot.canSubmit, false);
  } finally { await f.close(); }
});

test("project editing during the second navigation preparation cancels the pending engine switch", async () => {
  const f = await fixture(); const held = deferred();
  try {
    f.holds.set("fixture-secondary:2", held.promise);
    const old = f.commands.selectHost("fixture-secondary");
    await new Promise(resolve => setImmediate(resolve));
    f.commands.retargetDraft("initial", { hostId: asHostId("local"), workspace: { cwd: "/new-project", runtimeWorkspaceRoots: ["/new-project"] } });
    held.resolve(); await old;
    assert.equal(f.scopes.getActiveDraft()!.id, "initial");
    assert.equal(f.scopes.getActiveDraft()!.target.execution.workspace.cwd, "/new-project");
    assert.equal(f.coordinator.getSnapshot().selectedHostId, "local");
  } finally { held.resolve(); await f.close(); }
});


test("embedded boundary rejects machine/configuration actions before effects and preserves draft/history", async () => {
  const f = await fixture(false, false, EMBEDDED_CORE_CHAT_PRESENTATION);
  try {
    const before = f.coordinator.getSnapshot();
    const target = f.scopes.getActiveDraft()!.target.execution;
    await assert.rejects(f.commands.selectHost("fixture-secondary", { model: "late", effort: null }), /embedding product owns execution selection/);
    assert.throws(() => f.commands.retargetDraft("initial", { ...target, hostId: asHostId("other") }), /embedding product owns execution selection/);
    await assert.rejects(f.commands.provisionHost({} as never), /embedding product owns Host configuration/);
    await assert.rejects(f.commands.removeHost("other"), /embedding product owns Host configuration/);
    assert.throws(() => f.commands.navigateToHome({ execution: { ...target, hostId: asHostId("other") } }), /embedding product owns the execution target/);
    await assert.rejects(f.commands.navigate(createWorkbenchDraftLocation("other", "foreign")), /embedding product owns the execution target/);
    assert.equal(f.coordinator.getSnapshot().selectedHostId, before.selectedHostId);
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
    assert.equal(f.projectCreates, 0);
  } finally { await f.close(); }
});


test("New chat from a hidden Host falls back without carrying its remote project", async () => {
  const f = await fixture();
  try {
    Object.assign(f.profiles[0]!, { hideFromNewChat: true });
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "local", "changing visibility does not move the existing draft");
    f.commands.navigateToHome({ execution: f.scopes.getActiveDraft()!.target.execution });
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "fixture-secondary");
    assert.deepEqual(f.scopes.getActiveDraft()!.target.execution.workspace, { cwd: "/default", runtimeWorkspaceRoots: ["/default"] });
  } finally { await f.close(); }
});

test("a hidden Host is rejected before connection, including visibility changes during a held selection", async () => {
  const f = await fixture(); const held = deferred();
  try {
    Object.assign(f.profiles[1]!, { hideFromNewChat: true });
    await assert.rejects(f.commands.selectHost("fixture-secondary"));
    assert.equal(f.calls.has("fixture-secondary"), false);
    Object.assign(f.profiles[1]!, { hideFromNewChat: false });
    f.holds.set("fixture-secondary", held.promise);
    const pending = f.commands.selectHost("fixture-secondary");
    Object.assign(f.profiles[1]!, { hideFromNewChat: true });
    held.resolve(); await pending;
    assert.equal(f.scopes.getActiveDraft()!.target.execution.hostId, "local");
    assert.equal(composerDocumentToPlainText(f.composer().getSnapshot().draft.document), "keep my draft");
  } finally { held.resolve(); await f.close(); }
});
