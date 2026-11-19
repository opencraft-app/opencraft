import type { WorkspaceCatalog } from '@opencraft/appserver-protocol';
import { ordinaryNativeRouting } from './ordinary-native-routing';
import type { createWorkspaceExecutionAuthority } from '@opencraft/sandbox-node/workspace-execution-channel';
import { e2bSandboxBackend } from "../../../packages/sandbox-e2b/src/index";
import { InstalledOrdinarySandboxAllocator } from "./ordinary-sandbox-allocator";
import type { InstalledSandboxBudget } from "./installed-sandbox-budget";
import { join } from "node:path";
import type { TransportSubmissionContext } from "@opencraft/appserver-client/transport";
import type { HostFileSelector } from "../../../scripts/host-filesystem-transport";
import type { HostTerminalServiceSelector } from "../../../scripts/host-terminal-transport";
import { OrdinaryWorkspaceStore } from "../../../apps/local-agent-host/src/ordinary-workspace-store";
import { InstalledOrdinaryEnvironmentCatalog } from "./ordinary-environment-catalog";
import { InstalledOrdinaryConversationRuntime } from "./ordinary-conversation-runtime";
import { InstalledOrdinaryWorkspaceSources, PublishedOrdinaryGitSources } from "./ordinary-git-sources";
import { admitOrdinaryWorkspace, admitOrdinaryBrowserOwner } from "./ordinary-workspace-admission";
import { ordinaryWorkspaceFileSelector } from "./ordinary-workspace-files";
import { ordinaryWorkspaceTerminalSelector } from "./ordinary-workspace-terminal";
import type { SandboxConfigurations } from "./sandbox-configurations";

type AdmissionDependencies = Parameters<typeof admitOrdinaryWorkspace>[1];

/** One owner per identity service, not per socket or account. No public create API:
 * allocation is enabled only by the separately admitted Native composition. */
export class OrdinaryWorkspaceServices {
  readonly catalog: InstalledOrdinaryEnvironmentCatalog;
  readonly runtime: InstalledOrdinaryConversationRuntime;
  private readonly store: OrdinaryWorkspaceStore;
  private closed = false;
  private cleanupUnconfirmed = false;
  private closing?: Promise<void>;
  private readonly files = new WeakMap<HostFileSelector, Map<string, HostFileSelector>>();
  private readonly terminals = new WeakMap<HostTerminalServiceSelector, Map<string, HostTerminalServiceSelector>>();
  constructor(private readonly options: {
    dataDirectory: string;
    machineId: string;
    budget?: InstalledSandboxBudget;
    configurations: SandboxConfigurations;
    actors: AdmissionDependencies["actors"];
    getInstanceAccess: AdmissionDependencies["getInstanceAccess"];
  }) {
    this.catalog = new InstalledOrdinaryEnvironmentCatalog(options.configurations);
    const sources = new InstalledOrdinaryWorkspaceSources(this.catalog,
      new PublishedOrdinaryGitSources(options.configurations.vault));
    this.store = new OrdinaryWorkspaceStore(join(options.dataDirectory, "ordinary-workspaces"), options.machineId);
    try {
      this.runtime = new InstalledOrdinaryConversationRuntime(this.store, this.catalog, sources, {
        ...(options.budget ? { allocator: new InstalledOrdinarySandboxAllocator(this.catalog,
          { backend: input => options.budget!.wrap("ordinary", e2bSandboxBackend(input)) }) } : {}),
      });
    } catch (error) { this.store.close(); throw error; }
  }
  private assert() { if (this.closed) throw Error("Ordinary workspace services closed"); }
  admit(hostId: string, context: TransportSubmissionContext) {
    this.assert();
    return admitOrdinaryWorkspace(context, { actors: this.options.actors,
      getInstanceAccess: this.options.getInstanceAccess, hostId, current: () => !this.closed });
  }
  /** Descriptor comes only from the central persisted browser registry. */
  async browserRoute(input: { ownerId: string; hostId: string; threadId: string | null },
    local: { assertCurrent(): void; connect(): Promise<unknown> }, assertThreadAccess: () => void) {
    this.assert();
    const admission = admitOrdinaryBrowserOwner(input.ownerId, { actors: this.options.actors,
      getInstanceAccess: this.options.getInstanceAccess, hostId: input.hostId, current: () => !this.closed });
    const assertCurrent = () => {
      this.assert(); assertThreadAccess();
      if (!admission.catalog.current()) throw Error('Browser owner authority retired');
    };
    assertCurrent(); await admission.authorize();
    if (input.threadId === null || !this.runtime.hasPlacement(input.hostId, input.threadId)) return { lease: local, assertCurrent };
    const binding = await this.runtime.bindingFor(admission, input.threadId);
    assertCurrent();
    const browser = (binding as typeof binding & {browser?: typeof local}).browser;
    if (!browser) throw Error('Workspace browser is not configured');
    browser.assertCurrent();
    return { lease: browser, assertCurrent };
  }
  selectFiles(hostId: string, context: TransportSubmissionContext, params: unknown, local: HostFileSelector) {
    this.assert();
    let hosts = this.files.get(local);
    if (!hosts) { hosts = new Map(); this.files.set(local, hosts); }
    let select = hosts.get(hostId);
    if (!select) {
      select = ordinaryWorkspaceFileSelector({ runtime: this.runtime, admit: c => this.admit(hostId, c), local });
      hosts.set(hostId, select);
    }
    return select(context, params);
  }
  selectTerminal(hostId: string, scope: Parameters<HostTerminalServiceSelector>[0],
    context: TransportSubmissionContext, local: HostTerminalServiceSelector) {
    this.assert();
    if (scope.hostId !== hostId) return Promise.reject(Error("Terminal Host mismatch"));
    let hosts = this.terminals.get(local);
    if (!hosts) { hosts = new Map(); this.terminals.set(local, hosts); }
    let select = hosts.get(hostId);
    if (!select) {
      select = ordinaryWorkspaceTerminalSelector({ runtime: this.runtime, admit: c => this.admit(hostId, c), local });
      hosts.set(hostId, select);
    }
    return select(scope, context);
  }
  async readFileScope(hostId: string, context: TransportSubmissionContext, threadId: string) {
    return this.runtime.fileScopeFor(this.admit(hostId,context),threadId);
  }
  async readCatalog(hostId: string, context: TransportSubmissionContext): Promise<WorkspaceCatalog> {
    const admission=this.admit(hostId,context);
    await admission.authorize();
    const snapshot=this.catalog.snapshot(admission.catalog);
    await admission.authorize();
    return {version:1,environments:snapshot.environments,
      libraries:snapshot.libraries.map(({id,name,status,environmentIds})=>({id,name,status,environmentIds}))};
  }
  /** Caller owns the shared private authority; invoked once per physical adapter. */
  nativeHooks(hostId: string, authority: Awaited<ReturnType<typeof createWorkspaceExecutionAuthority>>) {
    this.assert();
    return ordinaryNativeRouting({hostId,authority,runtime:this.runtime,
      admit: context => this.admit(hostId,context),
      restoreProvisional: input => this.restoreProvisional({...input,hostId}),
      onCleanupUnconfirmed: () => { this.cleanupUnconfirmed = true; },
    });
  }
  /** Uses fresh live Native creation evidence, NOT a fabricated resume reply. */
  async restoreProvisional(input: { hostId: string; threadId: string;
    context: TransportSubmissionContext; confirm(): Promise<unknown> }) {
    const admission = this.admit(input.hostId, input.context);
    let confirmed = false;
    const confirm = async () => {
      await admission.authorize();
      const evidence = await input.confirm();
      if ((evidence as { thread?: { id?: unknown } } | null)?.thread?.id !== input.threadId)
        throw Error("Provisional Native thread conflict");
      await admission.authorize(); confirmed = true; return evidence;
    };
    await this.runtime.restore({ admission, threadId: input.threadId, nativeResume: confirm });
    if (!confirmed) await confirm();
    await admission.authorize();
  }
  close() {
    return this.closing ??= (async () => {
      this.closed = true;
      const failures: unknown[] = [];
      try { await this.runtime.close(); } catch (error) { failures.push(error); }
      try { this.store.close(); } catch (error) { failures.push(error); }
      if (this.cleanupUnconfirmed) failures.push(Error("Native attachment cleanup unconfirmed"));
      if (failures.length) throw new AggregateError(failures, "Ordinary workspace service cleanup unconfirmed");
    })();
  }
}
