import "../../apps/workbench-web/src/runtime/web-crypto-compat";
import { useCallback, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { LocaleRuntime } from "@opencraft/i18n";
import { IntlRuntimeProvider } from "@opencraft/i18n/react";
import { buildOpenCraftThemeCssProperties } from "@opencraft/design-system/theme-engine";
import { OpenCraftComposer } from "@opencraft/composer-editor";
import { composerDocumentToPlainText, type ComposerAttachment, type ComposerController } from "@opencraft/composer-core";
import {
  HostRuntimeRegistry, asRouteScopeId, createWorkbenchCoordinator,
  createConversationBindingStore, createConversationDraftOwnerRegistry,
  createConversationScopeLeaseRegistry, createConversationScopeRegistry,
  createConversationViewRegistry, createConversationActivationCoordinator,
  createWorkbenchThreadLocation,
} from "@opencraft/workbench-runtime";
import { attachmentPreviewSession } from "../../packages/composer-editor/src/attachment-preview-session";
import { createWorkbenchNavigationTransaction } from "../../apps/workbench-web/src/runtime/workbench-navigation-transaction";
import { createWorkbenchEntryResolver } from "../../apps/workbench-web/src/runtime/workbench-location-restoration";

// Production navigation, resource owners and Task editor. The two external
// boundaries are remote Host activation and attachment preparation/staging.
let sequence = 0;
const services = { now: Date.now, createId: () => `browser-task-draft-${++sequence}` };
const remote = { async connect() {}, async dispose() {},
  async acquireThread(threadId: string) { return { threadId, release() {} }; } };
const hosts = new HostRuntimeRegistry([{ descriptor: { hostId: "local", label: "Task fixture", kind: "local",
  transportEndpoint: null, executionLocation: null, workspaceBrowseRoots: [] }, createRuntime: () => remote }]);
const initial = createWorkbenchThreadLocation("local", "a");
const scopes = createConversationScopeRegistry({ initialDraft: null });
const coordinator = createWorkbenchCoordinator(hosts, initial);
const bindings = createConversationBindingStore();
const leases = createConversationScopeLeaseRegistry({});
const owners = createConversationDraftOwnerRegistry({ composerServices: services });
const views = createConversationViewRegistry({ scopeLeases: leases, composerServices: services, draftOwners: owners });
const activation = createConversationActivationCoordinator(coordinator, bindings, scopes, leases, views);
const resolveRestoredEntry = createWorkbenchEntryResolver({ hasHost: id => hosts.has(id), bindings, scopes, views,
  fallback: () => ({ location: coordinator.getSnapshot().location,
    routeScopeId: asRouteScopeId(coordinator.getSnapshot().viewId!) }) });
const navigation = createWorkbenchNavigationTransaction(initial, activation, scopes, {
  mode: "memory", resolveRestoredEntry, isRetainedView: (_location, viewId) => owners.get(viewId) !== null,
});
activation.mountInitial(initial, navigation.getSnapshot().routeScopeId);
const originalView = navigation.getSnapshot().routeScopeId;
const originalController = views.get(originalView)!.composer;
const current = () => views.get(navigation.getSnapshot().routeScopeId)!.composer;

interface Job {
  readonly controller: ComposerController;
  readonly file: File;
  readonly pending: ComposerAttachment;
  readonly signal?: AbortSignal;
  readonly complete: (attachment: ComposerAttachment) => void;
  settled: boolean;
}
const jobs: Job[] = [];
let sends = 0;
function resolveAttachment(controller: ComposerController, file: File, pending: ComposerAttachment, signal?: AbortSignal) {
  return new Promise<ComposerAttachment>(complete => jobs.push({ controller, file, pending, signal, complete, settled: false }));
}
function snapshot() {
  const controller = current(), draft = controller.getSnapshot().draft;
  const session = attachmentPreviewSession(controller);
  return { viewId: navigation.getSnapshot().routeScopeId, draftId: draft.id,
    text: composerDocumentToPlainText(draft.document), hasContent: controller.getSnapshot().hasContent,
    attachments: draft.attachments.map(asset => ({ ...asset, previewUrl: session.previewUrl(draft.id, asset.id) })),
    sameOriginalController: controller === originalController,
    originalViewCached: views.get(originalView) !== null,
    originalOwnerRetained: owners.get(originalView)?.composer === originalController,
    jobs: jobs.map(job => ({ name: job.file.name, aborted: job.signal?.aborted ?? false, settled: job.settled })), sends };
}
async function select(thread: string) {
  const accepted = await navigation.selectConversation(createWorkbenchThreadLocation("local", thread));
  if (!accepted || coordinator.getSnapshot().phase !== "ready") throw new Error(`Task ${thread} failed to activate`);
  return snapshot();
}

function TaskEditor() {
  const route = useSyncExternalStore(navigation.subscribe, navigation.getSnapshot, navigation.getSnapshot);
  const controller = views.get(route.routeScopeId)!.composer;
  const resolver = useCallback((file: File, pending: ComposerAttachment, signal?: AbortSignal) =>
    resolveAttachment(controller, file, pending, signal), [controller]);
  return <main className="thread-layout-width" data-task-view={route.routeScopeId}>
    <OpenCraftComposer key={route.routeScopeId} controller={controller} onResolveAttachment={resolver}
      modelSelectionPolicy="host-default" onSubmit={() => { sends++; throw new Error("Fixture must not send"); }}
      onCancel={() => {}} />
  </main>;
}

const locale = new LocaleRuntime([]);
await locale.update({ ideLocale: "en-US" });
document.documentElement.dataset.theme = "light";
for (const [key, value] of Object.entries(buildOpenCraftThemeCssProperties("light"))) document.documentElement.style.setProperty(key, value);
createRoot(document.getElementById("root")!).render(<IntlRuntimeProvider runtime={locale}><TaskEditor /></IntlRuntimeProvider>);
Object.assign(window, { __taskDraftFixture: {
  snapshot, select,
  async visitContent(count: number) {
    for (let index = 0; index < count; index++) {
      await select(`cached-${index}`);
      current().dispatch({ type: "set-document", document: {
        version: 1, blocks: [{ type: "paragraph", children: [{ type: "text", text: `Cached input ${index}` }] }],
      } });
    }
    return snapshot();
  },
  async completeFiles() {
    for (const job of jobs) {
      if (job.settled) continue;
      job.settled = true;
      const bytes = new Uint8Array(await job.file.arrayBuffer());
      const data = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""));
      job.complete({ ...job.pending, lifecycle: "ready", error: null,
        uri: job.pending.mimeType.startsWith("image/") ? `data:${job.pending.mimeType};base64,${data}` : `file:///fixture/${job.file.name}` });
    }
    await new Promise(resolve => setTimeout(resolve, 0));
    return snapshot();
  },
  async retainedFileBytes() {
    const controller = current(), draft = controller.getSnapshot().draft;
    const session = attachmentPreviewSession(controller);
    return Promise.all(draft.attachments.map(asset => new Promise<{ name: string; bytes: number[] }>((resolve, reject) => {
      if (!session.retry(draft.id, asset.id, async (selected, pending) => {
        const bytes = Array.from(new Uint8Array(await selected.arrayBuffer()));
        resolve({ name: selected.name, bytes });
        return { ...pending, lifecycle: "ready", error: null };
      })) reject(new Error(`No original File retained for ${asset.name}`));
    })));
  },
  clear() { current().dispatch({ type: "clear" }); return snapshot(); },
  settle(status: "accepted" | "failed") {
    const controller = current(), draft = controller.getSnapshot().draft;
    const intent = controller.createSubmitIntent();
    controller.dispatch({ type: "set-lifecycle", phase: "submitting" });
    controller.settleSubmission(draft.id, intent, status === "accepted" ? { status } : { status, error: "Fixture send failure" });
    return snapshot();
  },
  revoke() { views.replaceDraftContinuity(undefined); return snapshot(); },
} });
